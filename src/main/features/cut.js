// Bereich Schneiden: schneidet Abschnitte aus lokalen Dateien, wahlweise ohne Neukodierung.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { runFfmpeg, concatFiles, probeMedia } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');
const { t } = require('../core/i18n');

function validate(options, media) {
  if (options.sections.length === 0) throw new UserError(t('Bitte lege mindestens einen Abschnitt fest.'));
  if (!options.folder) throw new UserError(t('Bitte wähle einen Zielordner.'));
  for (const { start, end } of options.sections) {
    if (!(end > start) || start < 0) throw new UserError(t('Bei einem Abschnitt liegt das Ende vor dem Start.'));
    if (end > media.duration + 1) throw new UserError(t('Ein Abschnitt geht über das Ende des Videos hinaus.'));
  }
}

function outputExtension(options, media) {
  if (options.mode === 'fast') return path.extname(media.path);
  return media.hasVideo ? '.mp4' : '.m4a';
}

function sectionArgs({ start, end }, options, media, output) {
  const range = ['-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', media.path];

  if (options.mode === 'fast') {
    return [...range, '-map', '0:v:0?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', output];
  }
  const audio = media.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'] : [];
  const video = media.hasVideo
    ? ['-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']
    : [];
  return [...range, ...video, ...audio, output];
}

function register({ ipcMain, queue, tools }) {
  async function runExport(options, media, job) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    const ext = outputExtension(options, media);
    const baseName = path.parse(media.name).name;
    const { sections } = options;
    const total = sections.reduce((sum, { start, end }) => sum + end - start, 0);
    const pieces = [];
    let finished = 0;

    try {
      for (const [index, section] of sections.entries()) {
        const length = section.end - section.start;
        const piece = path.join(tempDir, `teil-${index + 1}${ext}`);
        const label = sections.length > 1 ? t('Abschnitt {number} von {total}', { number: index + 1, total: sections.length }) : t('Schneidet');
        job.update({ detail: label });

        await runFfmpeg(tools.path('ffmpeg'), sectionArgs(section, options, media, piece), {
          duration: length,
          signal: job.signal,
          onProgress: (part) => job.update({ progress: ((finished + part * length) / total) * 100, detail: label }),
        });
        finished += length;
        pieces.push(piece);
      }

      if (options.merge && pieces.length > 1) {
        job.update({ detail: t('Fügt Abschnitte zusammen …'), progress: null });
        const merged = path.join(tempDir, `gesamt${ext}`);
        await concatFiles(tools.path('ffmpeg'), pieces, merged, job.signal);
        return await moveFile(merged, options.folder, `${baseName} (${t('geschnitten')})${ext}`);
      }

      let saved = null;
      for (const [index, piece] of pieces.entries()) {
        const suffix = pieces.length > 1 ? t('Teil {number}', { number: index + 1 }) : t('geschnitten');
        saved = await moveFile(piece, options.folder, `${baseName} (${suffix})${ext}`);
      }
      return saved;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('cut:export', async (_event, options) => {
    try {
      const media = await probeMedia(tools.path('ffprobe'), options.filePath);
      validate(options, media);
      queue.add({
        title: media.name,
        kind: 'cut',
        run: (job) => runExport(options, media, job),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });
}

module.exports = { register };
