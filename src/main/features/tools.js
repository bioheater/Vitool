// Bereich Werkzeuge: GIF erstellen, Audio extrahieren, Standbild speichern, Untertitel einbrennen.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { run } = require('../core/process-runner');
const { runFfmpeg, probeMedia } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');
const { AUDIO_FORMATS } = require('./convert');

const COPY_EXTENSIONS = {
  aac: 'm4a', mp3: 'mp3', opus: 'opus', vorbis: 'ogg', flac: 'flac', ac3: 'ac3',
};
const STYLABLE_SUBTITLES = ['.srt', '.vtt'];
const SUBTITLE_FONT_SIZES = { klein: 16, mittel: 22, gross: 30 };

function secondsLabel(time) {
  const total = Math.floor(time);
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  return `${minutes}-${String(total % 60).padStart(2, '0')}`;
}

function requireVideo(media) {
  if (!media.hasVideo) throw new UserError('Diese Datei enthält kein Video.');
}

function gifSteps(options, media, tempDir) {
  requireVideo(media);
  const { start, end, width, fps } = options;
  if (!(end > start) || start < 0 || end > media.duration + 1) {
    throw new UserError('Bitte wähle einen gültigen Abschnitt für das GIF.');
  }
  const scale = width ? `,scale=${width}:-2:flags=lanczos` : '';
  const filter = `fps=${fps}${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
  const output = path.join(tempDir, 'ergebnis.gif');

  return {
    output,
    fileName: `${path.parse(media.name).name}.gif`,
    args: ['-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', media.path, '-filter_complex', filter, '-loop', '0', output],
    duration: end - start,
    label: 'Erstellt GIF',
  };
}

function audioSteps(options, media, tempDir) {
  if (!media.hasAudio) throw new UserError('Diese Datei enthält keine Tonspur.');
  const baseName = path.parse(media.name).name;

  if (options.format === 'original') {
    const ext = COPY_EXTENSIONS[media.audioCodec] ?? 'mka';
    const output = path.join(tempDir, `ergebnis.${ext}`);
    return {
      output,
      fileName: `${baseName} (Audio).${ext}`,
      args: ['-i', media.path, '-vn', '-map', '0:a:0', '-c:a', 'copy', output],
      duration: media.duration,
      label: 'Extrahiert Audio',
    };
  }

  const format = AUDIO_FORMATS[options.format];
  if (!format) throw new UserError('Dieses Format wird nicht unterstützt.');
  const output = path.join(tempDir, `ergebnis.${options.format}`);
  return {
    output,
    fileName: `${baseName} (Audio).${options.format}`,
    args: ['-i', media.path, '-vn', '-map', '0:a:0', '-c:a', format.codec, ...format.quality, output],
    duration: media.duration,
    label: 'Extrahiert Audio',
  };
}

function frameSteps(options, media, tempDir) {
  requireVideo(media);
  const ext = options.format === 'jpg' ? 'jpg' : 'png';
  const output = path.join(tempDir, `ergebnis.${ext}`);
  const quality = ext === 'jpg' ? ['-q:v', '2'] : [];
  return {
    output,
    fileName: `${path.parse(media.name).name} (Standbild ${secondsLabel(options.time)}).${ext}`,
    args: ['-ss', options.time.toFixed(3), '-i', media.path, '-frames:v', '1', ...quality, '-update', '1', output],
    label: 'Speichert Standbild',
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
  if (!options.subtitlePath) throw new UserError('Bitte wähle eine Untertitel-Datei.');

  const ext = path.extname(options.subtitlePath).toLowerCase();
  const localName = `untertitel${ext}`;
  await fs.copyFile(options.subtitlePath, path.join(tempDir, localName)).catch(() => {
    throw new UserError('Die Untertitel-Datei wurde nicht gefunden.');
  });

  try {
    await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', path.join(tempDir, localName)]);
  } catch {
    throw new UserError('Die Untertitel-Datei lässt sich nicht lesen. Unterstützt werden SRT, ASS und VTT.');
  }

  const bytes = await fs.readFile(path.join(tempDir, localName));
  const encoding = needsLegacyEncoding(bytes) ? ':charenc=CP1252' : '';
  const fontSize = SUBTITLE_FONT_SIZES[options.fontSize] ?? SUBTITLE_FONT_SIZES.mittel;
  const style = STYLABLE_SUBTITLES.includes(ext) ? `:force_style='FontSize=${fontSize}'` : '';
  const audio = media.hasAudio
    ? ['-map', '0:a:0', ...(['aac', 'mp3'].includes(media.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'])]
    : [];
  const output = path.join(tempDir, 'ergebnis.mp4');

  return {
    output,
    fileName: `${path.parse(media.name).name} (mit Untertiteln).mp4`,
    args: [
      '-i', media.path, '-map', '0:v:0', ...audio,
      // Über den relativen Namen entfallen die Sonderregeln für Windows-Pfade im Filter.
      '-vf', `subtitles=${localName}${encoding}${style}`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
    ],
    duration: media.duration,
    label: 'Brennt Untertitel ein',
  };
}

function register({ ipcMain, queue, tools }) {
  function prepare(options, media, tempDir) {
    switch (options.tool) {
      case 'gif': return gifSteps(options, media, tempDir);
      case 'audio': return audioSteps(options, media, tempDir);
      case 'frame': return frameSteps(options, media, tempDir);
      case 'subtitle': return subtitleSteps(options, media, tempDir, tools.path('ffprobe'));
      default: throw new UserError('Dieses Werkzeug gibt es nicht.');
    }
  }

  async function runTool(step, options, tempDir, job) {
    try {
      job.update({ detail: step.label });
      await runFfmpeg(tools.path('ffmpeg'), step.args, {
        cwd: tempDir,
        duration: step.duration,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: part * 100, detail: step.label }),
      });
      return await moveFile(step.output, options.folder, step.fileName);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('tools:start', async (_event, options) => {
    let tempDir = null;
    try {
      if (!options.folder) throw new UserError('Bitte wähle einen Zielordner.');
      const media = await probeMedia(tools.path('ffprobe'), options.filePath);
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
      const step = await prepare(options, media, tempDir);
      queue.add({
        title: media.name,
        kind: options.tool,
        run: (job) => runTool(step, options, tempDir, job),
      });
      return { ok: true };
    } catch (error) {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: toGermanMessage(error) };
    }
  });
}

module.exports = { register };
