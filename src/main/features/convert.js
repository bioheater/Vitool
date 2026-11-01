// Bereich Konvertieren: Format wechseln, auf Zielgröße komprimieren, Auflösung und 9:16.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { runFfmpeg, probeMedia } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');

const MB = 1024 * 1024;
const SIZE_MARGIN = 0.96; // Etwas Luft für den Dateikopf, damit die Zielgröße sicher hält.
const MIN_VIDEO_KBPS = 60;
const MAX_SIZE_ATTEMPTS = 3;
const MIN_BITS_PER_PIXEL = 0.04;
const STANDARD_HEIGHTS = [1080, 720, 540, 480, 360, 240];

const VIDEO_FORMATS = {
  mp4: { videoCodecs: ['h264', 'hevc', 'av1'], audioCodecs: ['aac', 'mp3'] },
  mov: { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'mp3'] },
  mkv: { videoCodecs: null, audioCodecs: null },
  webm: { videoCodecs: ['vp8', 'vp9', 'av1'], audioCodecs: ['opus', 'vorbis'] },
};

const AUDIO_FORMATS = {
  mp3: { codec: 'libmp3lame', quality: ['-q:a', '2'], sizable: true },
  m4a: { codec: 'aac', quality: ['-b:a', '192k'], sizable: true },
  wav: { codec: 'pcm_s16le', quality: [], sizable: false },
  flac: { codec: 'flac', quality: [], sizable: false },
};

function allows(allowed, codec) {
  return allowed === null || allowed.includes(codec);
}

function isEven(value) {
  return `trunc(${value}/2)*2`;
}

function portraitSize(media) {
  const width = Math.min(media.width, (media.height * 9) / 16);
  return { width, height: (width * 16) / 9 };
}

// Größte Standardhöhe, bei der die Bitrate noch für ein brauchbares Bild reicht.
function fittingHeight(media, videoKbps, portrait) {
  const source = portrait ? portraitSize(media) : media;
  const aspect = source.width / source.height;
  const fits = (height) => (videoKbps * 1000) / (height * height * aspect * media.fps) >= MIN_BITS_PER_PIXEL;

  if (fits(source.height)) return null;
  return STANDARD_HEIGHTS.find((height) => height < source.height && fits(height)) ?? 240;
}

function planTargetSize(options, media) {
  const totalKbps = Math.min(
    (options.targetSizeMb * MB * SIZE_MARGIN * 8) / media.duration / 1000,
    ((media.size * 8) / media.duration / 1000),
  );
  if (!media.hasVideo || AUDIO_FORMATS[options.format]) return { audioKbps: Math.min(Math.floor(totalKbps), 320) };

  const audioKbps = media.hasAudio ? (totalKbps >= 1000 ? 128 : 64) : 0;
  const videoKbps = Math.floor(totalKbps - audioKbps);
  if (videoKbps < MIN_VIDEO_KBPS) {
    const minimum = Math.ceil(((MIN_VIDEO_KBPS + audioKbps) * 1000 * media.duration) / 8 / MB / SIZE_MARGIN);
    throw new UserError(`Die Zielgröße ist für diese Länge zu klein. Nötig sind mindestens ${minimum} MB.`);
  }
  const autoHeight = options.height ? null : fittingHeight(media, videoKbps, options.portrait);
  return { videoKbps, audioKbps, autoHeight };
}

function buildPlan(options, media) {
  const audioFormat = AUDIO_FORMATS[options.format];
  const videoFormat = VIDEO_FORMATS[options.format];
  if (!audioFormat && !videoFormat) throw new UserError('Dieses Format wird nicht unterstützt.');
  if (videoFormat && !media.hasVideo) throw new UserError('Diese Datei enthält kein Video. Wähle bitte ein Audioformat.');
  if (audioFormat && !media.hasAudio) throw new UserError('Diese Datei enthält keine Tonspur.');

  const wantsSize = Boolean(options.targetSizeMb);
  if (wantsSize && !(options.targetSizeMb > 0)) throw new UserError('Bitte gib eine gültige Zielgröße ein.');
  if (wantsSize && audioFormat && !audioFormat.sizable) {
    throw new UserError('WAV und FLAC können nicht auf eine Zielgröße komprimiert werden.');
  }

  const sameFormat = path.extname(media.path).slice(1).toLowerCase() === options.format;
  const changesPicture = Boolean(videoFormat && (options.height || options.portrait));
  if (wantsSize && !changesPicture && sameFormat && media.size <= options.targetSizeMb * MB) {
    throw new UserError('Die Datei ist bereits kleiner als die Zielgröße.');
  }

  const size = wantsSize ? planTargetSize(options, media) : {};
  const encodeVideo = Boolean(videoFormat)
    && (wantsSize || changesPicture || !allows(videoFormat.videoCodecs, media.videoCodec));
  const copyAudio = Boolean(videoFormat)
    && media.hasAudio && !wantsSize && allows(videoFormat.audioCodecs, media.audioCodec);

  return {
    ...size,
    format: options.format,
    isAudio: Boolean(audioFormat),
    encodeVideo,
    copyAudio,
    height: options.height ?? size.autoHeight ?? null,
    portrait: Boolean(videoFormat && options.portrait),
    cropPosition: options.cropPosition ?? 0.5,
  };
}

function describePlan(plan) {
  if (plan.isAudio) {
    return plan.audioKbps
      ? `Tonspur wird mit ${plan.audioKbps} kbit/s gespeichert.`
      : 'Die Tonspur wird als Audiodatei gespeichert.';
  }
  if (!plan.encodeVideo && plan.copyAudio) return 'Wird nur umverpackt. Das dauert Sekunden und die Qualität bleibt gleich.';
  if (!plan.encodeVideo) return 'Das Bild bleibt unverändert, nur der Ton wird neu kodiert.';

  const parts = ['Wird neu kodiert. Das kann je nach Länge dauern.'];
  if (plan.videoKbps) parts.push(`Videobitrate etwa ${plan.videoKbps} kbit/s.`);
  if (plan.autoHeight) parts.push(`Für brauchbare Bildqualität wird auf ${plan.autoHeight}p verkleinert.`);
  return parts.join(' ');
}

function videoFilters(plan) {
  const filters = [];
  if (plan.portrait) {
    const width = isEven('min(iw\\,ih*9/16)');
    const height = isEven('min(iw*16/9\\,ih)');
    filters.push(`crop=${width}:${height}:(iw-ow)*${plan.cropPosition}:(ih-oh)/2`);
  }
  if (plan.height) {
    filters.push(plan.portrait
      ? `scale=${isEven(`min(${plan.height}\\,iw)`)}:-2`
      : `scale=-2:${isEven(`min(${plan.height}\\,ih)`)}`);
  }
  return filters.length ? ['-vf', filters.join(',')] : [];
}

function videoCodecArgs(plan) {
  if (plan.format === 'webm') {
    const rate = plan.videoKbps ? ['-b:v', `${plan.videoKbps}k`] : ['-crf', '32', '-b:v', '0'];
    return ['-c:v', 'libvpx-vp9', ...rate, '-row-mt', '1', '-cpu-used', '4', '-pix_fmt', 'yuv420p'];
  }
  const rate = plan.videoKbps ? ['-b:v', `${plan.videoKbps}k`] : ['-crf', '20'];
  return ['-c:v', 'libx264', '-preset', 'medium', ...rate, '-pix_fmt', 'yuv420p'];
}

function audioCodecArgs(plan) {
  if (plan.copyAudio) return ['-c:a', 'copy'];
  const kbps = plan.audioKbps ?? 192;
  return plan.format === 'webm' ? ['-c:a', 'libopus', '-b:a', `${kbps}k`] : ['-c:a', 'aac', '-b:a', `${kbps}k`];
}

function containerArgs(plan) {
  return plan.format === 'mp4' || plan.format === 'mov' ? ['-movflags', '+faststart'] : [];
}

function register({ ipcMain, queue, tools }) {
  const ffmpeg = () => tools.path('ffmpeg');

  function runAudio(media, plan, output, job) {
    const format = AUDIO_FORMATS[plan.format];
    const quality = plan.audioKbps ? ['-b:a', `${plan.audioKbps}k`] : format.quality;
    return runFfmpeg(ffmpeg(), ['-i', media.path, '-vn', '-map', '0:a:0', '-c:a', format.codec, ...quality, output], {
      duration: media.duration,
      signal: job.signal,
      onProgress: (part) => job.update({ progress: part * 100, detail: 'Konvertiert' }),
    });
  }

  function runSinglePass(media, plan, output, job) {
    const video = plan.encodeVideo ? [...videoFilters(plan), ...videoCodecArgs(plan)] : ['-c:v', 'copy'];
    const audioMap = plan.copyAudio ? ['-map', '0:a?'] : ['-map', '0:a:0?'];
    return runFfmpeg(ffmpeg(), [
      '-i', media.path, '-map', '0:v:0', ...audioMap, ...video, ...audioCodecArgs(plan), ...containerArgs(plan), output,
    ], {
      duration: media.duration,
      signal: job.signal,
      onProgress: (part) => job.update({ progress: part * 100, detail: 'Konvertiert' }),
    });
  }

  // Zwei Durchgänge: Der erste misst das Video, der zweite verteilt die Bitrate passend.
  async function runTwoPass(media, plan, output, tempDir, job, note) {
    const common = ['-i', media.path, '-map', '0:v:0', ...videoFilters(plan), ...videoCodecArgs(plan)];
    const logFile = path.join(tempDir, 'pass');
    const options = (start, label) => ({
      duration: media.duration,
      signal: job.signal,
      onProgress: (part) => job.update({ progress: start + part * 50, detail: label }),
    });

    await runFfmpeg(ffmpeg(), [
      ...common, '-pass', '1', '-passlogfile', logFile, '-an', '-f', 'null', 'NUL',
    ], options(0, `Analysiert (Durchgang 1 von 2${note})`));

    await runFfmpeg(ffmpeg(), [
      ...common, '-map', '0:a:0?', '-pass', '2', '-passlogfile', logFile,
      ...audioCodecArgs(plan), ...containerArgs(plan), output,
    ], options(50, `Komprimiert (Durchgang 2 von 2${note})`));
  }

  // Schwieriges Material kann über der Zielgröße landen. Dann läuft es mit weniger Bitrate erneut
  // und, falls niemand die Auflösung festgelegt hat, eine Stufe kleiner.
  async function runCompressed(media, plan, output, tempDir, job, options) {
    const targetBytes = options.targetSizeMb * MB;
    let { videoKbps, height } = plan;

    for (let attempt = 1; attempt <= MAX_SIZE_ATTEMPTS && videoKbps >= MIN_VIDEO_KBPS; attempt += 1) {
      const note = attempt > 1 ? `, Versuch ${attempt} von ${MAX_SIZE_ATTEMPTS}` : '';
      await runTwoPass(media, { ...plan, videoKbps, height }, output, tempDir, job, note);
      const { size } = await fs.stat(output);
      if (size <= targetBytes) return;

      videoKbps = Math.floor(videoKbps * (targetBytes / size) * 0.92);
      if (!options.height) {
        const current = height ?? media.height;
        height = STANDARD_HEIGHTS.find((step) => step < current) ?? current;
      }
    }
    throw new UserError('Die Zielgröße wurde nicht erreicht. Wähle bitte eine größere Zielgröße oder eine kleinere Auflösung.');
  }

  async function runConvert(options, media, plan, job) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    const output = path.join(tempDir, `ergebnis.${plan.format}`);
    const baseName = path.parse(media.name).name;

    try {
      if (plan.isAudio) await runAudio(media, plan, output, job);
      else if (plan.videoKbps) await runCompressed(media, plan, output, tempDir, job, options);
      else await runSinglePass(media, plan, output, job);

      const suffix = options.targetSizeMb ? 'komprimiert' : 'konvertiert';
      return await moveFile(output, options.folder, `${baseName} (${suffix}).${plan.format}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('convert:plan', async (_event, options) => {
    try {
      const media = await probeMedia(tools.path('ffprobe'), options.filePath);
      return { ok: true, summary: describePlan(buildPlan(options, media)) };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  ipcMain.handle('convert:start', async (_event, options) => {
    try {
      const media = await probeMedia(tools.path('ffprobe'), options.filePath);
      const plan = buildPlan(options, media);
      if (!options.folder) throw new UserError('Bitte wähle einen Zielordner.');
      queue.add({
        title: media.name,
        kind: 'convert',
        run: (job) => runConvert(options, media, plan, job),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });
}

module.exports = { register, AUDIO_FORMATS };
