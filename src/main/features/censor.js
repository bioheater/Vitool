// Zensieren: bewegliche Felder mit Blur, Verpixelung oder schwarzer Fläche ins Video rechnen.
// FFmpeg kann die Größe eines Bereichs nicht fließend ändern. Deshalb entsteht hier für jedes
// Einzelbild eine Maske, die als zweiter Videostrom an FFmpeg geht.
const fs = require('fs/promises');
const { once } = require('events');
const os = require('os');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { runFfmpeg, probeMedia, videoEncoderArgs } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');
const { t } = require('../core/i18n');

const MASK_WIDTH = 640;
const MAX_FPS = 60;

function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

// Position, Größe und Stärke zwischen zwei Keyframes gleichmäßig berechnen.
function boxAt(keyframes, time) {
  const next = keyframes.findIndex((keyframe) => keyframe.time >= time);
  if (next === -1) return keyframes.at(-1);
  if (next === 0) return keyframes[0];
  const before = keyframes[next - 1];
  const after = keyframes[next];
  const part = (time - before.time) / (after.time - before.time);
  const mix = (key) => before[key] + (after[key] - before[key]) * part;
  return { x: mix('x'), y: mix('y'), w: mix('w'), h: mix('h'), strength: mix('strength') };
}

function drawField(mask, field, time, size, top) {
  const box = boxAt(field.keyframes, time);
  const left = Math.max(0, Math.round(box.x * size.width));
  const right = Math.min(size.width, Math.round((box.x + box.w) * size.width));
  const first = Math.max(0, Math.round(box.y * size.height));
  const last = Math.min(size.height, Math.round((box.y + box.h) * size.height));

  if (field.shape !== 'ellipse') {
    for (let row = first; row < last; row += 1) {
      const start = (top + row) * size.width;
      mask.fill(255, start + left, start + right);
    }
    return;
  }

  const centerX = (left + right) / 2;
  const centerY = (first + last) / 2;
  const radiusX = (right - left) / 2;
  const radiusY = (last - first) / 2;
  for (let row = first; row < last; row += 1) {
    const offset = (row + 0.5 - centerY) / radiusY;
    const reach = radiusX * Math.sqrt(Math.max(0, 1 - offset * offset));
    const start = (top + row) * size.width;
    mask.fill(255, start + Math.max(0, Math.round(centerX - reach)), start + Math.min(size.width, Math.round(centerX + reach)));
  }
}

// Die Masken aller Felder liegen im Datenstrom untereinander.
async function writeMasks(stdin, fields, size, frameCount, fps) {
  for (let frame = 0; frame < frameCount && !stdin.destroyed; frame += 1) {
    const time = frame / fps;
    const mask = Buffer.alloc(size.width * size.height * fields.length);
    fields.forEach((field, index) => {
      if (time >= field.start && time <= field.end) drawField(mask, field, time, size, index * size.height);
    });
    if (!stdin.write(mask)) await Promise.race([once(stdin, 'drain'), once(stdin, 'close')]);
  }
  stdin.end();
}

// area ist die bearbeitete Fläche, referenceHeight die Höhe des ganzen Bilds. So bleibt die Stärke
// gleich, auch wenn nur ein Ausschnitt bearbeitet wird.
function effectSizes(strengthValue, referenceHeight) {
  const scale = referenceHeight / 720;
  const strength = Math.min(100, Math.max(1, strengthValue));
  return {
    block: Math.max(2, Math.round((strength / 100) * 60 * scale)),
    sigma: (strength / 100) * 50 * scale,
  };
}

// tag benennt die Filter, damit eine wechselnde Stärke sie unterwegs verstellen kann.
function effectFilter(field, area, referenceHeight = area.height, tag = null) {
  const { block, sigma } = effectSizes(field.strength, referenceHeight);
  const name = (filter, prefix) => (tag === null ? filter : `${filter}@${prefix}${tag}`);
  if (field.effect === 'black') return 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill';
  if (field.effect === 'pixel') {
    return `${name('scale', 'd')}=${even(area.width / block)}:${even(area.height / block)}:flags=area,scale=${area.width}:${area.height}:flags=neighbor`;
  }
  return `${name('gblur', 'f')}=sigma=${sigma.toFixed(1)}:sigmaV=${sigma.toFixed(1)}`;
}

// Ändert sich die Stärke über Keyframes, bekommt FFmpeg für jedes Bild, in dem sich etwas tut,
// einen Befehl. Blur braucht dabei beide Richtungen, sonst wirkt er nur waagerecht.
function strengthCommands(field, tag, area, video, fps) {
  const lines = [];
  let previous = null;
  const lastFrame = Math.ceil(field.end * fps);
  for (let frame = 0; frame <= lastFrame; frame += 1) {
    const time = frame / fps;
    const { block, sigma } = effectSizes(boxAt(field.keyframes, Math.max(time, field.start)).strength, video.height);
    const value = field.effect === 'pixel'
      ? `scale@d${tag} w ${even(area.width / block)}, scale@d${tag} h ${even(area.height / block)}`
      : `gblur@f${tag} sigma ${sigma.toFixed(1)}, gblur@f${tag} sigmaV ${sigma.toFixed(1)}`;
    if (value !== previous) lines.push(`${time.toFixed(4)} ${value};`);
    previous = value;
  }
  return lines.join('\n');
}

function strengthChanges(field) {
  return field.effect !== 'black' && new Set(field.keyframes.map((key) => key.strength)).size > 1;
}

// Weiche Kante: Die Maske wird weichgezeichnet, der Übergang liegt dann mittig auf dem Rand des Felds.
// Die Werte gelten für ein 720p-Bild, so sieht es bei jeder Auflösung gleich aus.
const MAX_FEATHER = 30;

function featherSigma(field, video) {
  const feather = Math.min(100, Math.max(0, field.feather ?? 0));
  return (feather / 100) * MAX_FEATHER * (video.height / 720);
}

// Die Fläche, die ein Feld während seiner ganzen Zeit berührt, plus Rand für weiche Kante und Blur.
// Nur sie wird bearbeitet. Das spart bei kleinen Feldern in 4K den größten Teil der Rechenzeit.
function fieldArea(field, video) {
  const { block, sigma } = effectSizes(Math.max(...field.keyframes.map((key) => key.strength)), video.height);
  // Ein Sigma Rand genügt: Am Ausschnittrand wiederholt der Blur die Randpixel, das ist im Feld nicht zu sehen.
  // Volle drei Sigma würden bei starkem Blur in 4K fast das ganze Bild umfassen.
  const effectReach = field.effect === 'blur' ? sigma : field.effect === 'pixel' ? block : 0;
  const margin = Math.ceil(effectReach + 2.5 * featherSigma(field, video) + 4);
  const left = Math.min(...field.keyframes.map((key) => key.x)) * video.width - margin;
  const top = Math.min(...field.keyframes.map((key) => key.y)) * video.height - margin;
  const right = Math.max(...field.keyframes.map((key) => key.x + key.w)) * video.width + margin;
  const bottom = Math.max(...field.keyframes.map((key) => key.y + key.h)) * video.height + margin;
  const x = Math.max(0, Math.floor(left / 2) * 2);
  const y = Math.max(0, Math.floor(top / 2) * 2);
  return {
    x,
    y,
    width: Math.min(video.width - x, even(Math.ceil(right) - x + 1)),
    height: Math.min(video.height - y, even(Math.ceil(bottom) - y + 1)),
  };
}

// Liefert den Filter und, für Felder mit wechselnder Stärke, die Befehlsdateien dazu.
function buildFilter(fields, video, mask, fps) {
  const count = fields.length;
  const labels = fields.map((_field, index) => `[s${index}]`).join('');
  const commands = [];
  const chain = [
    `[0:v]fps=${fps},scale=${video.width}:${video.height},format=yuv420p[base0]`,
    count > 1 ? `[1:v]split=${count}${labels}` : '[1:v]null[s0]',
  ];

  fields.forEach((field, index) => {
    const area = fieldArea(field, video);
    const crop = `crop=${area.width}:${area.height}:${area.x}:${area.y}`;
    const sigma = featherSigma(field, video);
    const soften = sigma > 0.2 ? `,gblur=sigma=${sigma.toFixed(2)}` : '';
    const during = `between(t,${(field.start - 0.05).toFixed(3)},${(field.end + 0.05).toFixed(3)})`;
    const startStrength = { ...field, strength: boxAt(field.keyframes, field.start).strength };
    let effect = effectFilter(startStrength, area, video.height);
    if (strengthChanges(field)) {
      const file = `staerke${index}.txt`;
      commands.push({ file, content: strengthCommands(field, index, area, video, fps) });
      // Relativer Name: Die Datei liegt im Arbeitsordner, so entfallen die Regeln für Windows-Pfade.
      effect = `sendcmd=f=${file},${effectFilter(startStrength, area, video.height, index)}`;
    }
    chain.push(
      `[s${index}]crop=${mask.width}:${mask.height}:0:${index * mask.height},scale=${video.width}:${video.height}:flags=bilinear,format=gray,${crop}${soften}[m${index}]`,
      `[base${index}]split[keep${index}][src${index}]`,
      `[src${index}]${crop},${effect},format=yuva420p[fx${index}]`,
      `[fx${index}][m${index}]alphamerge[fg${index}]`,
      `[keep${index}][fg${index}]overlay=${area.x}:${area.y}:shortest=1:format=auto:enable='${during}'[base${index + 1}]`,
    );
  });
  return { filter: chain.join(';'), commands };
}

function validate(options, media) {
  if (!media.hasVideo) throw new UserError(t('Diese Datei enthält kein Video.'));
  if (!options.folder) throw new UserError(t('Bitte wähle einen Zielordner.'));
  if (options.fields.length === 0) throw new UserError(t('Bitte füge mindestens ein Feld hinzu.'));
  if (options.fields.some((field) => field.keyframes.length === 0 || !(field.end > field.start))) {
    throw new UserError(t('Bei einem Feld stimmt der Zeitraum nicht.'));
  }
}

function register({ ipcMain, queue, tools }) {
  async function runCensor(options, media, job) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    const output = path.join(tempDir, 'ergebnis.mp4');
    // Ältere Felder hatten eine feste Stärke für das ganze Feld, sie gilt dann für jeden Keyframe.
    const fields = options.fields.map((field) => ({
      ...field,
      keyframes: [...field.keyframes]
        .map((key) => ({ ...key, strength: key.strength ?? field.strength ?? 50 }))
        .sort((a, b) => a.time - b.time),
    }));
    const fps = Math.round(Math.min(media.fps, MAX_FPS) * 1000) / 1000;
    const video = { width: even(media.width), height: even(media.height) };
    const maskWidth = even(Math.min(MASK_WIDTH, video.width));
    const mask = { width: maskWidth, height: even((maskWidth * video.height) / video.width) };
    const frameCount = Math.ceil(media.duration * fps) + 2;
    const audio = media.hasAudio
      ? ['-map', '0:a:0', ...(['aac', 'mp3'].includes(media.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'])]
      : [];

    try {
      const encoder = await videoEncoderArgs(tools.path('ffmpeg'));
      const { filter, commands } = buildFilter(fields, video, mask, fps);
      for (const { file, content } of commands) await fs.writeFile(path.join(tempDir, file), content, 'utf8');
      await runFfmpeg(tools.path('ffmpeg'), [
        '-i', media.path,
        '-f', 'rawvideo', '-pix_fmt', 'gray', '-video_size', `${mask.width}x${mask.height * fields.length}`, '-framerate', String(fps), '-i', 'pipe:0',
        '-filter_complex', filter,
        '-map', `[base${fields.length}]`, ...audio,
        ...encoder, '-movflags', '+faststart', output,
      ], {
        cwd: tempDir,
        duration: media.duration,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: part * 100, detail: t('Zensiert') }),
        writeInput: (stdin) => {
          writeMasks(stdin, fields, mask, frameCount, fps);
        },
      });
      return await moveFile(output, options.folder, `${path.parse(media.name).name} (${t('zensiert')}).mp4`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('censor:start', async (_event, options) => {
    try {
      const media = await probeMedia(tools.path('ffprobe'), options.filePath);
      validate(options, media);
      queue.add({
        title: media.name,
        kind: 'censor',
        run: (job) => runCensor(options, media, job),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });
}

module.exports = { register, boxAt, effectFilter, even };
