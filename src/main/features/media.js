// Lokale Dateien einlesen und Vorschauen erstellen. Wird von mehreren Bereichen genutzt.
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { toGermanMessage } = require('../core/error-messages');
const { CanceledError } = require('../core/process-runner');
const { runFfmpeg, probeMedia } = require('../core/ffmpeg');

const previewDir = path.join(os.tmpdir(), `vitool-vorschau-${process.pid}`);

function register({ ipcMain, queue, tools }) {
  // Kleine H.264-Kopie für Dateien, die der Player nicht selbst abspielen kann.
  async function runPreview(media, job) {
    await fs.mkdir(previewDir, { recursive: true });
    const output = path.join(previewDir, `${Date.now()}.mp4`);
    job.update({ detail: 'Erstellt Vorschau' });
    await runFfmpeg(tools.path('ffmpeg'), [
      '-i', media.path,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=-2:2*trunc(min(480\\,ih)/2)',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output,
    ], {
      duration: media.duration,
      signal: job.signal,
      onProgress: (part) => job.update({ progress: part * 100, detail: 'Erstellt Vorschau' }),
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

  ipcMain.handle('media:preparePreview', async (_event, filePath) => {
    try {
      const media = await probeMedia(tools.path('ffprobe'), filePath);
      const output = await new Promise((resolve, reject) => {
        queue.add({
          title: `Vorschau: ${media.name}`,
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
