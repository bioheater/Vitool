// Greenscreen: eine Farbe ausstanzen und durch Farbe, Bild, Video oder Transparenz ersetzen.
// Die Vorschau in der Oberfläche rechnet mit denselben Formeln (components/chroma-editor.js).
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { runFfmpeg, probeMedia, videoEncoderArgs, audioKbpsFor } = require('../core/ffmpeg');
const { saveResult } = require('../core/drafts');
const { t } = require('../core/i18n');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];
const BACKGROUNDS = ['transparent', 'color', 'image', 'video'];
const TRANSPARENT_FORMATS = {
  webm: {
    ext: '.webm',
    pixel: 'yuva420p',
    video: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'],
    audio: ['-c:a', 'libopus', '-b:a', '160k'],
    opusCeiling: 160,
  },
  mov: {
    ext: '.mov',
    pixel: 'yuva444p10le',
    video: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0'],
    audio: ['-c:a', 'pcm_s16le'],
  },
};

const hex = (value) => /^#[0-9a-f]{6}$/i.test(value ?? '');
const even = (value) => Math.max(2, Math.floor(value / 2) * 2);

// Farbanteile wie im Video (BT.601, begrenzter Bereich). Das Bild wird vorher genau so umgerechnet,
// damit Schlüsselfarbe, Video und Vorschau im selben Farbraum liegen.
function keyUv(color) {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const u = Math.round(128 - 0.148 * r - 0.291 * g + 0.439 * b);
  const v = Math.round(128 + 0.439 * r - 0.368 * g - 0.071 * b);
  return { u: Math.min(255, Math.max(0, u)), v: Math.min(255, Math.max(0, v)), blue: b > g };
}

const toHex = (value) => value.toString(16).padStart(2, '0');

function checkOptions(options) {
  if (!hex(options.color)) throw new UserError(t('Bitte wähle die Farbe des Hintergrunds.'));
  if (!(options.similarity >= 0.01 && options.similarity <= 0.6)) throw new UserError(t('Diese Einstellung passt nicht.'));
  if (!(options.blend >= 0 && options.blend <= 0.5)) throw new UserError(t('Diese Einstellung passt nicht.'));
  if (!BACKGROUNDS.includes(options.background)) throw new UserError(t('Diesen Hintergrund gibt es nicht.'));
  if (options.background === 'color' && !hex(options.backgroundColor)) throw new UserError(t('Bitte wähle eine Hintergrundfarbe.'));
  if (['image', 'video'].includes(options.background) && !options.backgroundPath) throw new UserError(t('Bitte wähle ein Hintergrundbild oder -video.'));
  if (options.background === 'transparent' && !TRANSPARENT_FORMATS[options.transparentFormat]) throw new UserError(t('Dieses Format wird nicht unterstützt.'));
}

// WebM bekommt Opus, höchstens 160 kbit/s und nicht mehr als die Quelle. MOV bleibt verlustfrei (PCM).
function transparentAudio(format, media) {
  if (!format.opusCeiling) return format.audio;
  return ['-c:a', 'libopus', '-b:a', `${audioKbpsFor(media, format.opusCeiling)}k`];
}

function buildGraph(options, size, fps, backgroundIsImage, input) {
  const { u, v, blue } = keyUv(options.color);
  const lines = [];
  const key = [
    `[${input}]format=rgb24`,
    'scale=out_color_matrix=bt601:out_range=tv',
    'format=yuva444p',
    `chromakey=color=0x80${toHex(u)}${toHex(v)}:yuv=1:similarity=${options.similarity.toFixed(4)}:blend=${options.blend.toFixed(4)}`,
    'format=gbrap',
  ];
  if (options.despill) key.push(`despill=type=${blue ? 'blue' : 'green'}:mix=0.5:expand=0`);
  const cover = `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},setsar=1`;

  if (options.background === 'transparent') {
    lines.push(`${key.join(',')},scale=${size.width}:${size.height},format=${TRANSPARENT_FORMATS[options.transparentFormat].pixel}[v]`);
    return lines;
  }
  lines.push(`${key.join(',')},scale=${size.width}:${size.height}[vorne]`);
  if (options.background === 'color') {
    lines.push(`color=c=0x${options.backgroundColor.slice(1)}:s=${size.width}x${size.height}:r=${fps}[hinten]`);
  } else {
    lines.push(`[1:v]${cover},fps=${fps}${backgroundIsImage ? '' : ',setpts=PTS-STARTPTS'}[hinten]`);
  }
  lines.push('[hinten][vorne]overlay=shortest=1:format=auto,format=yuv420p[v]');
  return lines;
}

function register({ ipcMain, queue, tools }) {
  async function runChroma(options, media, job) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    try {
      const ffmpeg = tools.path('ffmpeg');
      const size = { width: even(media.width), height: even(media.height) };
      const fps = media.fps > 0 && media.fps <= 120 ? Number(media.fps.toFixed(3)) : 30;
      const backgroundIsImage = options.background === 'image'
        && IMAGE_EXTENSIONS.includes(path.extname(options.backgroundPath).toLowerCase());
      const inputs = ['-i', media.path];
      if (options.background === 'image' || options.background === 'video') {
        // Bilder laufen als Standbild mit, Videos wiederholen sich, falls sie kürzer sind.
        inputs.push(...(backgroundIsImage ? ['-loop', '1', '-framerate', String(fps)] : ['-stream_loop', '-1']), '-i', options.backgroundPath);
      }
      await fs.writeFile(path.join(tempDir, 'filter.txt'), buildGraph(options, size, fps, backgroundIsImage, media.videoMap).join(';\n'), 'utf8');

      const transparent = options.background === 'transparent' ? TRANSPARENT_FORMATS[options.transparentFormat] : null;
      const audio = !media.hasAudio ? []
        : ['-map', '0:a:0', ...(transparent ? transparentAudio(transparent, media)
          : ['aac', 'mp3'].includes(media.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', `${audioKbpsFor(media)}k`])];
      const video = transparent ? transparent.video : [...await videoEncoderArgs(ffmpeg, { sourceKbps: media.videoKbps }), '-movflags', '+faststart'];
      const ext = transparent ? transparent.ext : '.mp4';
      const output = path.join(tempDir, `ergebnis${ext}`);
      const label = t('Ersetzt den Hintergrund');
      job.update({ detail: label });
      await runFfmpeg(ffmpeg, [
        ...inputs, '-/filter_complex', 'filter.txt', '-map', '[v]', ...audio, ...video,
        '-t', media.duration.toFixed(3), output,
      ], {
        cwd: tempDir,
        duration: media.duration,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: part * 100, detail: label }),
      });
      return await saveResult(output, options, `${path.parse(media.name).name} (${t('Greenscreen')})${ext}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('chroma:start', async (_event, options) => {
    try {
      if (!options.folder) throw new UserError(t('Bitte wähle einen Zielordner.'));
      checkOptions(options);
      const media = await probeMedia(tools.path('ffprobe'), options.filePath);
      if (!media.hasVideo) throw new UserError(t('Diese Datei enthält kein Video.'));
      // Bilder haben keine Länge, deshalb wird nur ein Hintergrundvideo genauer geprüft.
      if (options.background === 'image') {
        await fs.access(options.backgroundPath).catch(() => {
          throw new UserError(t('Diese Datei wurde nicht gefunden. Vielleicht wurde sie verschoben.'));
        });
      } else if (options.background === 'video') {
        const background = await probeMedia(tools.path('ffprobe'), options.backgroundPath);
        if (!background.hasVideo) throw new UserError(t('Der Hintergrund enthält kein Bild.'));
      }
      const jobId = queue.add({
        title: media.name,
        kind: 'chroma',
        run: (job) => runChroma(options, media, job),
      });
      return { ok: true, jobId };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });
}

module.exports = { register, keyUv, buildGraph };
