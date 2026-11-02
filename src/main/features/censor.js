// Zensieren: bewegliche Felder mit Blur, Verpixelung oder schwarzer Fläche ins Video rechnen.
// FFmpeg kann die Größe eines Bereichs nicht fließend ändern. Deshalb entsteht hier für jedes
// Einzelbild eine Maske, die als zweiter Videostrom an FFmpeg geht.
const fs = require('fs/promises');
const { once } = require('events');
const os = require('os');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { runFfmpeg, probeMedia } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');

const MASK_WIDTH = 640;
const MAX_FPS = 60;

function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

// Position und Größe zwischen zwei Keyframes gleichmäßig berechnen.
function boxAt(keyframes, time) {
  const next = keyframes.findIndex((keyframe) => keyframe.time >= time);
  if (next === -1) return keyframes.at(-1);
  if (next === 0) return keyframes[0];
  const before = keyframes[next - 1];
  const after = keyframes[next];
  const part = (time - before.time) / (after.time - before.time);
  const mix = (key) => before[key] + (after[key] - before[key]) * part;
  return { x: mix('x'), y: mix('y'), w: mix('w'), h: mix('h') };
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

function effectFilter(field, video) {
  const scale = video.height / 720;
  const strength = Math.min(100, Math.max(1, field.strength));
  if (field.effect === 'black') return 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill';
  if (field.effect === 'pixel') {
    const block = Math.max(2, Math.round((strength / 100) * 60 * scale));
    return `scale=${even(video.width / block)}:${even(video.height / block)}:flags=area,scale=${video.width}:${video.height}:flags=neighbor`;
  }
  return `gblur=sigma=${((strength / 100) * 50 * scale).toFixed(1)}`;
}

function buildFilter(fields, video, mask, fps) {
  const count = fields.length;
  const labels = fields.map((_field, index) => `[s${index}]`).join('');
  const chain = [
    `[0:v]fps=${fps},scale=${video.width}:${video.height},format=yuv420p[base0]`,
    count > 1 ? `[1:v]split=${count}${labels}` : '[1:v]null[s0]',
  ];

  fields.forEach((field, index) => {
    chain.push(
      `[s${index}]crop=${mask.width}:${mask.height}:0:${index * mask.height},scale=${video.width}:${video.height}:flags=bilinear,format=gray[m${index}]`,
      `[base${index}]split[keep${index}][src${index}]`,
      `[src${index}]${effectFilter(field, video)},format=yuva420p[fx${index}]`,
      `[fx${index}][m${index}]alphamerge[fg${index}]`,
      `[keep${index}][fg${index}]overlay=shortest=1:format=auto[base${index + 1}]`,
    );
  });
  return chain.join(';');
}

function validate(options, media) {
  if (!media.hasVideo) throw new UserError('Diese Datei enthält kein Video.');
  if (!options.folder) throw new UserError('Bitte wähle einen Zielordner.');
  if (options.fields.length === 0) throw new UserError('Bitte füge mindestens ein Feld hinzu.');
  if (options.fields.some((field) => field.keyframes.length === 0 || !(field.end > field.start))) {
    throw new UserError('Bei einem Feld stimmt der Zeitraum nicht.');
  }
}

function register({ ipcMain, queue, tools }) {
  async function runCensor(options, media, job) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    const output = path.join(tempDir, 'ergebnis.mp4');
    const fields = options.fields.map((field) => ({
      ...field,
      keyframes: [...field.keyframes].sort((a, b) => a.time - b.time),
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
      await runFfmpeg(tools.path('ffmpeg'), [
        '-i', media.path,
        '-f', 'rawvideo', '-pix_fmt', 'gray', '-video_size', `${mask.width}x${mask.height * fields.length}`, '-framerate', String(fps), '-i', 'pipe:0',
        '-filter_complex', buildFilter(fields, video, mask, fps),
        '-map', `[base${fields.length}]`, ...audio,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
      ], {
        duration: media.duration,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: part * 100, detail: 'Zensiert' }),
        writeInput: (stdin) => {
          writeMasks(stdin, fields, mask, frameCount, fps);
        },
      });
      return await moveFile(output, options.folder, `${path.parse(media.name).name} (zensiert).mp4`);
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
