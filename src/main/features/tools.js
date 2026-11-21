// Bereich Werkzeuge: GIF erstellen, Standbild speichern, Untertitel einbrennen, Video anpassen.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { run } = require('../core/process-runner');
const { runFfmpeg, probeMedia, bitrateCap, audioKbpsFor, videoEncoderArgs } = require('../core/ffmpeg');
const { saveResult } = require('../core/drafts');
const { t } = require('../core/i18n');

const STYLABLE_SUBTITLES = ['.srt', '.vtt'];
const SUBTITLE_FONT_SIZES = { klein: 16, mittel: 22, gross: 30 };

function secondsLabel(time) {
  const total = Math.floor(time);
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  return `${minutes}-${String(total % 60).padStart(2, '0')}`;
}

function requireVideo(media) {
  if (!media.hasVideo) throw new UserError(t('Diese Datei enthält kein Video.'));
}

function gifSteps(options, media, tempDir) {
  requireVideo(media);
  const { start, end, width, fps } = options;
  if (!(end > start) || start < 0 || end > media.duration + 1) {
    throw new UserError(t('Bitte wähle einen gültigen Abschnitt für das GIF.'));
  }
  const scale = width ? `,scale=${width}:-2:flags=lanczos` : '';
  const filter = `[${media.videoMap}]fps=${fps}${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
  const output = path.join(tempDir, 'ergebnis.gif');

  return {
    output,
    fileName: `${path.parse(media.name).name}.gif`,
    args: ['-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', media.path, '-filter_complex', filter, '-loop', '0', output],
    duration: end - start,
    label: t('Erstellt GIF'),
  };
}

function frameSteps(options, media, tempDir) {
  requireVideo(media);
  const ext = options.format === 'jpg' ? 'jpg' : 'png';
  const output = path.join(tempDir, `ergebnis.${ext}`);
  const quality = ext === 'jpg' ? ['-q:v', '2'] : [];
  return {
    output,
    fileName: `${path.parse(media.name).name} (${t('Standbild {time}', { time: secondsLabel(options.time) })}).${ext}`,
    args: ['-ss', options.time.toFixed(3), '-i', media.path, '-map', media.videoMap, '-frames:v', '1', ...quality, '-update', '1', output],
    label: t('Speichert Standbild'),
  };
}

// Ältere deutsche SRT-Dateien sind oft nicht in UTF-8 gespeichert, sonst gehen die Umlaute kaputt.
function needsLegacyEncoding(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

async function subtitleSteps(options, media, tempDir, ffprobe) {
  requireVideo(media);
  if (!options.subtitlePath) throw new UserError(t('Bitte wähle eine Untertitel-Datei.'));

  const ext = path.extname(options.subtitlePath).toLowerCase();
  const localName = `untertitel${ext}`;
  await fs.copyFile(options.subtitlePath, path.join(tempDir, localName)).catch(() => {
    throw new UserError(t('Die Untertitel-Datei wurde nicht gefunden.'));
  });

  try {
    await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', path.join(tempDir, localName)]);
  } catch {
    throw new UserError(t('Die Untertitel-Datei lässt sich nicht lesen. Unterstützt werden SRT, ASS und VTT.'));
  }

  const bytes = await fs.readFile(path.join(tempDir, localName));
  const encoding = needsLegacyEncoding(bytes) ? ':charenc=CP1252' : '';
  const fontSize = SUBTITLE_FONT_SIZES[options.fontSize] ?? SUBTITLE_FONT_SIZES.mittel;
  const style = STYLABLE_SUBTITLES.includes(ext) ? `:force_style='FontSize=${fontSize}'` : '';
  const audio = media.hasAudio
    ? ['-map', '0:a:0', ...(['aac', 'mp3'].includes(media.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', `${audioKbpsFor(media)}k`])]
    : [];
  const output = path.join(tempDir, 'ergebnis.mp4');

  return {
    output,
    fileName: `${path.parse(media.name).name} (${t('mit Untertiteln')}).mp4`,
    args: [
      '-i', media.path, '-map', media.videoMap, ...audio,
      // Über den relativen Namen entfallen die Sonderregeln für Windows-Pfade im Filter.
      '-vf', `subtitles=${localName}${encoding}${style}`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', ...bitrateCap(media.videoKbps), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
    ],
    duration: media.duration,
    label: t('Brennt Untertitel ein'),
  };
}

// ---------------------------------------------------------------- Anpassen

// Drehen, spiegeln, schwarze Ränder entfernen, beruhigen und Tempo ändern, alles in einem Durchgang.
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8];
const ROTATIONS = { 0: [], 90: ['transpose=1'], 180: ['hflip', 'vflip'], 270: ['transpose=2'] };
// Leicht: kleine Wackler weg, Schwenks bleiben. Stark: wirkt wie vom Stativ, schneidet mehr vom Rand ab.
// Leicht vergrößert einmal für das ganze Video. Stark passt die Vergrößerung langsam an, damit bei
// großen Ausgleichsbewegungen nie leere Ränder entstehen, die sonst mit Resten alter Bilder gefüllt würden.
const STABILIZE = {
  light: { shakiness: 5, smoothing: 15, zoom: 'optzoom=1' },
  strong: { shakiness: 8, smoothing: 40, zoom: 'optzoom=2:zoomspeed=0.1' },
};
const filterChecks = new Map();

function hasFilter(ffmpeg, name) {
  if (!filterChecks.has(ffmpeg)) {
    filterChecks.set(ffmpeg, run(ffmpeg, ['-hide_banner', '-filters']).then(({ stdout }) => stdout, () => ''));
  }
  return filterChecks.get(ffmpeg).then((list) => new RegExp(`\\s${name}\\s`).test(list));
}

// atempo schafft je Stufe nur das Halbe bis Doppelte, für mehr werden Stufen hintereinander gehängt.
function atempoChain(speed) {
  const steps = [];
  let rest = speed;
  while (rest > 2) {
    steps.push('atempo=2');
    rest /= 2;
  }
  while (rest < 0.5) {
    steps.push('atempo=0.5');
    rest /= 0.5;
  }
  if (Math.abs(rest - 1) > 0.001) steps.push(`atempo=${rest.toFixed(4)}`);
  return steps.join(',');
}

function validCrop(crop, media) {
  if (!crop) return null;
  const values = ['x', 'y', 'w', 'h'].map((key) => Math.round(Number(crop[key])));
  const [x, y, w, h] = values;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (w < 16 || h < 16 || x + w > media.width || y + h > media.height) return null;
  if (w === media.width && h === media.height) return null;
  // Gerade Werte, sonst lehnt der Encoder das Format ab.
  return { x: x - (x % 2), y: y - (y % 2), w: w - (w % 2), h: h - (h % 2) };
}

async function adjustSteps(options, media, tempDir, ffmpeg) {
  requireVideo(media);
  const speed = SPEEDS.includes(Number(options.speed)) ? Number(options.speed) : 1;
  const rotation = ROTATIONS[options.rotate] ? Number(options.rotate) : 0;
  const crop = validCrop(options.crop, media);
  const stabilize = STABILIZE[options.stabilize] ?? null;
  const flipH = Boolean(options.flipH);
  const flipV = Boolean(options.flipV);
  if (speed === 1 && !rotation && !crop && !stabilize && !flipH && !flipV) {
    throw new UserError(t('Es ist noch nichts eingestellt.'));
  }

  const before = crop ? [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : [];
  const after = [...ROTATIONS[rotation], ...(flipH ? ['hflip'] : []), ...(flipV ? ['vflip'] : [])];
  const fps = media.fps && media.fps < 121 ? media.fps : 30;
  if (speed !== 1) {
    after.push(`setpts=PTS/${speed}`);
    // Schneller: überzählige Bilder fallen weg. Langsamer mit Zwischenbildern: flüssig, aber viel Rechenzeit.
    if (speed > 1) after.push(`fps=${fps.toFixed(3)}`);
    else if (options.smooth) after.push(`minterpolate=fps=${fps.toFixed(3)}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
  }

  const passes = [];
  let stabilizer = [];
  if (stabilize) {
    if (await hasFilter(ffmpeg, 'vidstabdetect')) {
      // Erster Durchgang misst die Bewegung, der zweite gleicht sie aus. Leicht nachschärfen,
      // weil das Verschieben das Bild etwas weicher macht.
      passes.push({
        label: t('Misst die Bewegung'),
        weight: 0.4,
        duration: media.duration,
        args: ['-i', media.path, '-map', media.videoMap, '-vf', [...before, `vidstabdetect=shakiness=${stabilize.shakiness}:accuracy=15:result=bewegung.trf`].join(','), '-an', '-f', 'null', '-'],
      });
      // "copy" gibt dem Filter eine eigene Kopie jedes Bildes. Ohne sie liest vidstabtransform in manchen
      // FFmpeg-Fassungen (etwa 8.1.1 von gyan.dev) Bilder, die der Decoder schon wiederverwendet:
      // Dann blitzen Blöcke aus anderen Bildern auf und das Ergebnis hängt von der Zahl der Threads ab.
      stabilizer = ['copy', `vidstabtransform=input=bewegung.trf:smoothing=${stabilize.smoothing}:${stabilize.zoom}:interpol=bicubic`, 'unsharp=5:5:0.6:3:3:0.3'];
    } else {
      stabilizer = ['deshake'];
    }
  }

  const filter = [...before, ...stabilizer, ...after, 'format=yuv420p'].join(',');
  const keepAudio = media.hasAudio && options.keepAudio !== false;
  let audio = ['-an'];
  if (keepAudio && speed === 1 && ['aac', 'mp3'].includes(media.audioCodec)) audio = ['-map', '0:a:0', '-c:a', 'copy'];
  else if (keepAudio) audio = ['-map', '0:a:0', ...(speed !== 1 ? ['-af', atempoChain(speed)] : []), '-c:a', 'aac', '-b:a', `${audioKbpsFor(media)}k`];
  const output = path.join(tempDir, 'ergebnis.mp4');
  passes.push({
    label: t('Passt das Video an'),
    weight: 1 - passes.reduce((sum, pass) => sum + pass.weight, 0),
    duration: media.duration / speed,
    args: [
      '-i', media.path, '-map', media.videoMap, ...audio,
      '-vf', filter,
      ...await videoEncoderArgs(ffmpeg, { sourceKbps: media.videoKbps }),
      '-movflags', '+faststart', output,
    ],
  });
  return {
    output,
    fileName: `${path.parse(media.name).name} (${t('angepasst')}).mp4`,
    passes,
    label: t('Passt das Video an'),
  };
}

// Schwarze Ränder finden: an mehreren Stellen messen und den größten Bildbereich nehmen. So schneidet
// eine dunkle Szene nicht versehentlich Bild ab.
async function detectBars(ffmpeg, media) {
  requireVideo(media);
  const points = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((share) => share * media.duration);
  let box = null;
  for (const time of points) {
    const { stderr } = await run(ffmpeg, [
      '-hide_banner', '-nostdin', '-ss', time.toFixed(2), '-i', media.path, '-map', media.videoMap,
      '-vf', 'cropdetect=limit=24:round=2:reset=0', '-frames:v', '40', '-an', '-f', 'null', '-',
    ]).catch((error) => ({ stderr: error?.message ?? '' }));
    const matches = [...String(stderr).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    const last = matches.at(-1);
    if (!last) continue;
    const [w, h, x, y] = last.slice(1).map(Number);
    if (!box) box = { x1: x, y1: y, x2: x + w, y2: y + h };
    else box = { x1: Math.min(box.x1, x), y1: Math.min(box.y1, y), x2: Math.max(box.x2, x + w), y2: Math.max(box.y2, y + h) };
  }
  if (!box) return null;
  const crop = validCrop({ x: box.x1, y: box.y1, w: box.x2 - box.x1, h: box.y2 - box.y1 }, media);
  // Ein paar Pixel Rand lohnen kein Neukodieren.
  if (!crop || (media.width - crop.w < 8 && media.height - crop.h < 8)) return null;
  return crop;
}

function register({ ipcMain, queue, tools }) {
  function prepare(options, media, tempDir) {
    switch (options.tool) {
      case 'gif': return gifSteps(options, media, tempDir);
      case 'frame': return frameSteps(options, media, tempDir);
      case 'subtitle': return subtitleSteps(options, media, tempDir, tools.path('ffprobe'));
      case 'adjust': return adjustSteps(options, media, tempDir, tools.path('ffmpeg'));
      default: throw new UserError(t('Dieses Werkzeug gibt es nicht.'));
    }
  }

  async function runTool(step, options, tempDir, job) {
    try {
      // Manche Werkzeuge brauchen zwei Durchgänge. Der Fortschritt läuft über beide.
      const passes = step.passes ?? [{ args: step.args, duration: step.duration, label: step.label, weight: 1 }];
      let done = 0;
      for (const pass of passes) {
        job.update({ detail: pass.label });
        await runFfmpeg(tools.path('ffmpeg'), pass.args, {
          cwd: tempDir,
          duration: pass.duration,
          signal: job.signal,
          onProgress: (part) => job.update({ progress: (done + part * pass.weight) * 100, detail: pass.label }),
        });
        done += pass.weight;
      }
      return await saveResult(step.output, options, step.fileName);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('tools:start', async (_event, options) => {
    let tempDir = null;
    try {
      if (!options.folder) throw new UserError(t('Bitte wähle einen Zielordner.'));
      const media = await probeMedia(tools.path('ffprobe'), options.filePath);
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
      const step = await prepare(options, media, tempDir);
      const jobId = queue.add({
        title: media.name,
        kind: options.tool,
        run: (job) => runTool(step, options, tempDir, job),
      });
      return { ok: true, jobId };
    } catch (error) {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  ipcMain.handle('tools:detectBars', async (_event, filePath) => {
    try {
      const media = await probeMedia(tools.path('ffprobe'), filePath);
      return { ok: true, crop: await detectBars(tools.path('ffmpeg'), media) };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });
}

module.exports = { register };
