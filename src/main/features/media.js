// Lokale Dateien einlesen und Vorschauen erstellen. Wird von mehreren Bereichen genutzt.
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { toGermanMessage } = require('../core/error-messages');
const { CanceledError } = require('../core/process-runner');
const { runFfmpeg, probeMedia } = require('../core/ffmpeg');
const { t } = require('../core/i18n');

const previewDir = path.join(os.tmpdir(), `vitool-vorschau-${process.pid}`);

function register({ ipcMain, queue, tools }) {
  // Kleine H.264-Kopie für Dateien, die der Player nicht selbst abspielen kann.
  async function runPreview(media, job) {
    await fs.mkdir(previewDir, { recursive: true });
    const output = path.join(previewDir, `${Date.now()}.mp4`);
    job.update({ detail: t('Erstellt Vorschau') });
    await runFfmpeg(tools.path('ffmpeg'), [
      '-i', media.path,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=-2:2*trunc(min(480\\,ih)/2)',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output,
    ], {
      duration: media.duration,
      signal: job.signal,
      onProgress: (part) => job.update({ progress: part * 100, detail: t('Erstellt Vorschau') }),
    });
    return output;
  }

  ipcMain.handle('media:probe', async (_event, filePath) => {
    try {
      const media = await probeMedia(tools.path('ffprobe'), filePath);
      return { ok: true, media: { ...media, url: pathToFileURL(filePath).href } };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  // Kleines Vorschaubild einer lokalen Datei. Das erste Bild ist oft schwarz oder ein Logo, deshalb
  // sucht FFmpeg um etwa ein Zehntel der Laufzeit aus mehreren Bildern ein typisches heraus.
  const thumbnails = new Map();
  ipcMain.handle('media:thumbnail', async (_event, filePath, duration) => {
    try {
      if (!thumbnails.has(filePath)) {
        await fs.mkdir(previewDir, { recursive: true });
        const output = path.join(previewDir, `bild-${Date.now()}-${thumbnails.size}.jpg`);
        const time = duration > 5 ? Math.min(duration * 0.1, 300) : 0;
        await runFfmpeg(tools.path('ffmpeg'), [
          '-ss', time.toFixed(2), '-i', filePath,
          '-map', '0:v:0', '-vf', 'thumbnail=40,scale=320:-2', '-frames:v', '1', '-q:v', '4', output,
        ]);
        thumbnails.set(filePath, pathToFileURL(output).href);
      }
      return { ok: true, url: thumbnails.get(filePath) };
    } catch {
      // Ohne Videospur oder bei unlesbarem Bild bleibt es einfach beim Text.
      return { ok: false };
    }
  });

  ipcMain.handle('media:preparePreview', async (_event, filePath) => {
    try {
      const media = await probeMedia(tools.path('ffprobe'), filePath);
      const output = await new Promise((resolve, reject) => {
        queue.add({
          title: t('Vorschau: {name}', { name: media.name }),
          kind: 'preview',
          run: (job) => runPreview(media, job).then(resolve, (error) => {
            reject(error);
            throw error;
          }),
        });
      });
      return { ok: true, url: pathToFileURL(output).href };
    } catch (error) {
      if (error instanceof CanceledError) return { ok: false, canceled: true };
      return { ok: false, error: toGermanMessage(error) };
    }
  });
}

function dispose() {
  fsSync.rmSync(previewDir, { recursive: true, force: true });
}

module.exports = { register, dispose };
