// Bereich Ton: Pausen entfernen, Rauschen mindern, die Lautstärke angleichen und den Ton herausholen, in einem Durchgang.
const fs = require('fs/promises');
const fsSync = require('fs');
const { pathToFileURL } = require('url');
const os = require('os');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { run, CanceledError } = require('../core/process-runner');
const { runFfmpeg, probeMedia, videoEncoderArgs, audioKbpsFor } = require('../core/ffmpeg');
const { saveResult } = require('../core/drafts');
const { t } = require('../core/i18n');

// Abstand der Pegelwerte in Sekunden. Fein genug für Pausen, und eine Stunde ergibt nur 72 000 Werte.
const LEVEL_STEP = 0.05;
const SILENT_DB = -100;
// Wie stark das Rauschen gesenkt wird, in dB.
const DENOISE = { light: 12, medium: 20, strong: 30 };
const PREVIEW_SECONDS = 15;
const previewDir = path.join(os.tmpdir(), `vitool-hoerprobe-${process.pid}`);
const LOUDNESS_TARGETS = [-14, -16, -23];
const TRUE_PEAK = -1.5;
const LOUDNESS_RANGE = 11;

// Wohin die Datei passt, ohne dass sich mehr ändert als nötig.
const AUDIO_OUTPUTS = {
  '.mp3': { ext: '.mp3', args: ['-c:a', 'libmp3lame', '-q:a', '2'] },
  '.m4a': { ext: '.m4a', args: ['-c:a', 'aac', '-b:a', '192k'] },
  '.aac': { ext: '.m4a', args: ['-c:a', 'aac', '-b:a', '192k'] },
  '.wav': { ext: '.wav', args: ['-c:a', 'pcm_s16le'] },
  '.flac': { ext: '.flac', args: ['-c:a', 'flac'] },
  '.ogg': { ext: '.ogg', args: ['-c:a', 'libopus', '-b:a', '128k'], rate: 48000 },
  '.opus': { ext: '.opus', args: ['-c:a', 'libopus', '-b:a', '128k'], rate: 48000 },
};
const MP4_VIDEO = ['h264', 'hevc', 'av1'];
// Nur den Ton speichern. MP3 kennt höchstens 48 kHz.
const AUDIO_ONLY = {
  mp3: { ext: '.mp3', args: ['-c:a', 'libmp3lame', '-q:a', '2'], maxRate: 48000 },
  m4a: { ext: '.m4a', args: ['-c:a', 'aac', '-b:a', '192k'] },
  wav: { ext: '.wav', args: ['-c:a', 'pcm_s16le'] },
  flac: { ext: '.flac', args: ['-c:a', 'flac'] },
};
// Unverändert übernommen landet die Tonspur in dem Behälter, der zu ihr passt.
const COPY_EXTENSIONS = {
  aac: '.m4a', mp3: '.mp3', opus: '.opus', vorbis: '.ogg', flac: '.flac', ac3: '.ac3', eac3: '.eac3',
};
const FORMATS = ['keep', 'original', ...Object.keys(AUDIO_ONLY)];

async function probeAudio(ffprobe, filePath) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_streams', filePath,
  ]);
  const { streams } = JSON.parse(stdout);
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const rate = String(video?.avg_frame_rate ?? '');
  const [num, den] = rate.split('/').map(Number);
  return {
    sampleRate: Number(audio?.sample_rate) || 48000,
    audioTracks: streams.filter((stream) => stream.codec_type === 'audio').length,
    // Ohne Bild schneidet Vitool auf die Millisekunde genau.
    frameRate: !video ? { num: 1000, den: 1 } : num > 0 && den > 0 ? { num, den } : { num: 30, den: 1 },
  };
}

// Pegel in Abständen von 50 ms, gemessen als RMS der ersten Tonspur.
async function readLevels(ffmpeg, media, { signal, onProgress }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
  try {
    const samples = Math.round(8000 * LEVEL_STEP);
    await runFfmpeg(ffmpeg, [
      '-i', media.path, '-map', '0:a:0', '-vn',
      // Über den relativen Namen entfallen die Sonderregeln für Windows-Pfade im Filter.
      '-af', `asetpts=PTS-STARTPTS,aresample=8000,asetnsamples=n=${samples}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=pegel.txt`,
      '-f', 'null', '-',
    ], { cwd: tempDir, duration: media.duration, signal, onProgress });
    const text = await fs.readFile(path.join(tempDir, 'pegel.txt'), 'utf8');
    const values = [];
    for (const match of text.matchAll(/RMS_level=(-?[\d.]+|-?inf|nan)/g)) {
      const value = Number(match[1]);
      values.push(Number.isFinite(value) ? Math.max(SILENT_DB, Math.round(value * 10) / 10) : SILENT_DB);
    }
    return { step: LEVEL_STEP, values };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Abschnitte auf das Bildraster legen. So enthalten Bild und Ton genau dieselbe Zeit,
// und auch nach Hunderten Schnitten bleibt der Ton lippensynchron.
function snapSections(sections, duration, frameRate) {
  const toFrame = (time) => Math.round((time * frameRate.num) / frameRate.den);
  const toTime = (frame) => (frame * frameRate.den) / frameRate.num;
  const snapped = [];
  for (const section of sections) {
    const start = toTime(toFrame(Math.max(0, section.start)));
    const end = toTime(toFrame(Math.min(duration, section.end)));
    if (end - start < 0.04) continue;
    const last = snapped.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else snapped.push({ start, end });
  }
  return snapped;
}

function validateSections(sections, duration) {
  if (!Array.isArray(sections) || sections.length === 0) throw new UserError(t('Nach dem Entfernen der Pausen bliebe nichts übrig.'));
  let previous = 0;
  for (const { start, end } of sections) {
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start && start >= previous && end <= duration + 1)) {
      throw new UserError(t('Die gefundenen Pausen passen nicht zur Datei. Bitte öffne sie noch einmal.'));
    }
    previous = end;
  }
}

// FFmpeg rechnet nur den passenden Zweig eines if() aus. Als Baum gebaut prüft jedes Bild
// deshalb nur etwa zehn Abschnitte statt aller.
function selectExpression(sections, shift) {
  const build = (low, high) => {
    if (high - low === 1) {
      const { start, end } = sections[low];
      return `between(t,${(start - shift).toFixed(6)},${(end - shift).toFixed(6)})`;
    }
    const middle = (low + high) >> 1;
    return `if(lt(t,${(sections[middle].start - shift).toFixed(6)}),${build(low, middle)},${build(middle, high)})`;
  };
  return build(0, sections.length);
}

// Rauschen wie ein Lüfter ist gleichmäßig, aber kein weißes Rauschen. Errät afftdn es selbst,
// bleibt es fast unverändert. Deshalb hört der Filter sich vorher eine ruhige Stelle an, an der
// nur das Rauschen zu hören ist. Sie wird vorne angehängt und danach wieder abgeschnitten.
function noiseInput(options, filePath) {
  if (!options.denoise || !options.noise) return [];
  const { start, end } = options.noise;
  return ['-ss', start.toFixed(3), '-t', (end - start + 0.5).toFixed(3), '-i', filePath];
}

// Zeilen des Filtergraphen für den Ton. Eingang 0 ist die Datei, Eingang 1 die ruhige Stelle.
function audioGraph(options, info, sections, extra = [], label = 'a') {
  const lines = [];
  let head = '[0:a:0]asetpts=PTS-STARTPTS';
  const filters = [];
  if (options.rumble) filters.push('highpass=f=80');
  if (options.denoise && options.noise) {
    const samples = Math.round((options.noise.end - options.noise.start) * info.sampleRate);
    const length = samples / info.sampleRate;
    const floor = Math.max(-80, Math.min(-20, Math.round(options.noise.level)));
    lines.push(`[1:a:0]asetpts=PTS-STARTPTS,atrim=end_sample=${samples}[rauschen]`);
    lines.push('[0:a:0]asetpts=PTS-STARTPTS[ton]');
    head = '[rauschen][ton]concat=n=2:v=0:a=1';
    filters.push(
      `asendcmd=c='0.02 afftdn sn start;${(length - 0.02).toFixed(3)} afftdn sn stop'`,
      `afftdn=nr=${DENOISE[options.denoise]}:nf=${floor}`,
      `atrim=start_sample=${samples}`,
      'asetpts=PTS-STARTPTS',
    );
  } else if (options.denoise) {
    filters.push(`afftdn=nr=${DENOISE[options.denoise]}:nf=-40:tn=1`);
  }
  if (sections) {
    const chunk = Math.max(1, Math.round(info.sampleRate / 1000));
    filters.push(`asetnsamples=n=${chunk}:p=0`, `aselect='${selectExpression(sections, chunk / info.sampleRate / 2)}'`, 'asetpts=N/SR/TB');
  }
  lines.push(`${[head, ...filters, ...extra].join(',')}[${label}]`);
  return lines;
}

function loudnormFilter(target, measured) {
  if (!measured) return null;
  return `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=${LOUDNESS_RANGE}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
}

// Misst die Lautheit nach allen anderen Bearbeitungen. Reine Stille ergibt null.
async function measureLoudness(ffmpeg, filePath, options, info, sections, tempDir, run) {
  const lines = audioGraph(options, info, sections, [`loudnorm=I=${options.loudness}:TP=${TRUE_PEAK}:LRA=${LOUDNESS_RANGE}:print_format=json`]);
  await fs.writeFile(path.join(tempDir, 'messung.txt'), lines.join(';\n'), 'utf8');
  const { stderr } = await runFfmpeg(ffmpeg, [
    '-i', filePath, ...noiseInput(options, filePath), '-/filter_complex', 'messung.txt', '-map', '[a]', '-f', 'null', '-',
  ], { cwd: tempDir, ...run });
  return parseLoudnorm(stderr);
}

// Die festen Raten oben sind Obergrenzen. Hat die Quelle weniger, wird der Ton nicht größer als sie.
function matchSourceRate(plan, media) {
  const index = plan.args.indexOf('-b:a');
  if (index < 0) return plan;
  const args = [...plan.args];
  args[index + 1] = `${audioKbpsFor(media, Number.parseInt(args[index + 1], 10))}k`;
  return { ...plan, args };
}

function outputPlan(media, reencodeVideo, format, sampleRate) {
  return matchSourceRate(basePlan(media, reencodeVideo, format, sampleRate), media);
}

function basePlan(media, reencodeVideo, format, sampleRate) {
  const audioOnly = AUDIO_ONLY[format];
  if (audioOnly) return { ...audioOnly, rate: audioOnly.maxRate ? Math.min(audioOnly.maxRate, sampleRate) : undefined, video: null };
  const source = path.extname(media.path).toLowerCase();
  if (!media.hasVideo) return { ...(AUDIO_OUTPUTS[source] ?? AUDIO_OUTPUTS['.m4a']), video: null };
  if (source === '.mkv') return { ext: '.mkv', args: ['-c:a', 'aac', '-b:a', '192k'], video: reencodeVideo ? 'encode' : 'copy' };
  if (source === '.webm' && !reencodeVideo) return { ext: '.webm', args: ['-c:a', 'libopus', '-b:a', '160k'], video: 'copy', rate: 48000 };
  const copyable = !reencodeVideo && MP4_VIDEO.includes(media.videoCodec);
  return { ext: '.mp4', args: ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'], video: copyable ? 'copy' : 'encode' };
}

function hasEdits(options) {
  return Boolean(options.sections || options.denoise || options.rumble || options.loudness);
}

function parseLoudnorm(stderr) {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const data = JSON.parse(stderr.slice(start, end + 1));
    const value = Number(data.input_i);
    return Number.isFinite(value) ? data : null;
  } catch {
    return null;
  }
}

// Die ruhige Stelle für das Rauschprofil kommt aus der Oberfläche und wird hier geprüft.
function checkOptions(options, duration) {
  options.format = options.format ?? 'keep';
  if (!FORMATS.includes(options.format)) throw new UserError(t('Dieses Format wird nicht unterstützt.'));
  if (options.denoise && !DENOISE[options.denoise]) throw new UserError(t('Diese Stärke gibt es nicht.'));
  if (options.loudness && !LOUDNESS_TARGETS.includes(options.loudness)) throw new UserError(t('Dieses Ziel gibt es nicht.'));
  const noise = options.noise;
  if (noise && !(Number.isFinite(noise.start) && Number.isFinite(noise.end) && Number.isFinite(noise.level)
    && noise.start >= 0 && noise.end <= duration + 0.5 && noise.end - noise.start >= 0.3 && noise.end - noise.start <= 5)) {
    options.noise = null;
  }
}

function register({ ipcMain, queue, tools, send }) {
  const levelCache = new Map();
  const loudnessCache = new Map();
  let levelRun = null;
  let previewRun = null;
  let previewCount = 0;

  ipcMain.handle('audio:levels', async (_event, filePath) => {
    levelRun?.abort();
    const controller = new AbortController();
    levelRun = controller;
    try {
      if (!levelCache.has(filePath)) {
        const media = await probeMedia(tools.path('ffprobe'), filePath);
        if (!media.hasAudio) throw new UserError(t('Diese Datei enthält keine Tonspur.'));
        const levels = await readLevels(tools.path('ffmpeg'), media, {
          signal: controller.signal,
          onProgress: (part) => send('audio:levelsProgress', { filePath, part }),
        });
        levelCache.set(filePath, levels);
      }
      return { ok: true, ...levelCache.get(filePath) };
    } catch (error) {
      if (error instanceof CanceledError || controller.signal.aborted) return { ok: false, canceled: true };
      return { ok: false, error: toGermanMessage(error) };
    } finally {
      if (levelRun === controller) levelRun = null;
    }
  });

  async function runAudio(options, media, info, job) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    try {
      const ffmpeg = tools.path('ffmpeg');
      const sections = options.sections ? snapSections(options.sections, media.duration, info.frameRate) : null;
      if (sections) validateSections(sections, media.duration);
      const length = sections ? sections.reduce((sum, { start, end }) => sum + end - start, 0) : media.duration;
      const baseName = path.parse(media.name).name;

      // Tonspur unverändert herausholen, ohne neu zu kodieren.
      if (options.format === 'original') {
        const ext = COPY_EXTENSIONS[media.audioCodec] ?? '.mka';
        const output = path.join(tempDir, `ergebnis${ext}`);
        const label = t('Extrahiert Audio');
        job.update({ detail: label });
        await runFfmpeg(ffmpeg, ['-i', media.path, '-vn', '-map', '0:a:0', '-c:a', 'copy', output], {
          duration: media.duration,
          signal: job.signal,
          onProgress: (part) => job.update({ progress: part * 100, detail: label }),
        });
        return await saveResult(output, options, `${baseName} (Audio)${ext}`);
      }

      const plan = outputPlan(media, Boolean(sections), options.format, info.sampleRate);
      const target = options.loudness;
      const passShare = target ? 0.25 : 0;

      let loudnorm = null;
      if (target) {
        const label = t('Misst die Lautstärke');
        job.update({ detail: label, progress: 0 });
        const measured = await measureLoudness(ffmpeg, media.path, options, info, sections, tempDir, {
          duration: length,
          signal: job.signal,
          onProgress: (part) => job.update({ progress: part * passShare * 100, detail: label }),
        });
        // Reine Stille lässt sich nicht angleichen. Dann bleibt die Lautstärke, wie sie ist.
        loudnorm = loudnormFilter(target, measured);
      }

      // loudnorm rechnet intern mit 192 kHz, danach geht es zurück auf die ursprüngliche Rate.
      const rate = plan.rate ?? info.sampleRate;
      const graph = audioGraph(options, info, sections, [...(loudnorm ? [loudnorm] : []), `aresample=${rate}`]);
      if (plan.video && sections) {
        const fps = `${info.frameRate.num}/${info.frameRate.den}`;
        graph.unshift(`[0:v:0]setpts=PTS-STARTPTS,fps=${fps},select='${selectExpression(sections, (0.5 * info.frameRate.den) / info.frameRate.num)}',setpts=N/FRAME_RATE/TB[v]`);
      }
      await fs.writeFile(path.join(tempDir, 'filter.txt'), graph.join(';\n'), 'utf8');

      const videoMap = !plan.video ? [] : sections ? ['-map', '[v]'] : ['-map', '0:v:0'];
      const videoCodec = !plan.video ? [] : plan.video === 'copy' ? ['-c:v', 'copy'] : await videoEncoderArgs(ffmpeg, { sourceKbps: media.videoKbps });
      const output = path.join(tempDir, `ergebnis${plan.ext}`);
      const edited = hasEdits(options);
      const label = sections ? t('Entfernt Pausen') : edited ? t('Bearbeitet den Ton') : t('Extrahiert Audio');
      job.update({ detail: label });
      await runFfmpeg(ffmpeg, [
        '-i', media.path, ...noiseInput(options, media.path), '-/filter_complex', 'filter.txt',
        ...videoMap, '-map', '[a]', ...videoCodec, ...plan.args, '-map_metadata', '0', output,
      ], {
        cwd: tempDir,
        duration: length,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: (passShare + part * (1 - passShare)) * 100, detail: label }),
      });

      const name = `${baseName} (${edited ? t('Ton bearbeitet') : 'Audio'})${plan.ext}`;
      return await saveResult(output, options, name);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Hörprobe: ein kurzes Stück ab der aktuellen Stelle, einmal unverändert und einmal bearbeitet.
  // Für die Lautstärke wird vorher die ganze Datei gemessen, damit die Probe so laut ist wie später der Export.
  ipcMain.handle('audio:preview', async (_event, options) => {
    previewRun?.abort();
    const controller = new AbortController();
    previewRun = controller;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    try {
      const ffmpeg = tools.path('ffmpeg');
      const media = await probeMedia(tools.path('ffprobe'), options.filePath);
      if (!media.hasAudio) throw new UserError(t('Diese Datei enthält keine Tonspur.'));
      checkOptions(options, media.duration);
      const info = await probeAudio(tools.path('ffprobe'), options.filePath);
      const length = Math.min(PREVIEW_SECONDS, media.duration);
      const start = Math.max(0, Math.min(Number(options.start) || 0, media.duration - length));
      const progress = (phase, part) => send('audio:previewProgress', { phase, part });

      let loudnorm = null;
      if (options.loudness) {
        const key = JSON.stringify([options.filePath, options.denoise, options.rumble, options.noise, options.loudness]);
        if (!loudnessCache.has(key)) {
          loudnessCache.set(key, await measureLoudness(ffmpeg, media.path, options, info, null, tempDir, {
            duration: media.duration,
            signal: controller.signal,
            onProgress: (part) => progress('measure', part),
          }));
        }
        loudnorm = loudnormFilter(options.loudness, loudnessCache.get(key));
      }

      await fs.mkdir(previewDir, { recursive: true });
      previewCount += 1;
      const original = path.join(previewDir, `original-${previewCount}.wav`);
      const processed = path.join(previewDir, `bearbeitet-${previewCount}.wav`);
      const lines = audioGraph(options, info, null, [...(loudnorm ? [loudnorm] : []), `aresample=${info.sampleRate}`]);
      lines.push('[0:a:0]asetpts=PTS-STARTPTS[o]');
      await fs.writeFile(path.join(tempDir, 'probe.txt'), lines.join(';\n'), 'utf8');
      await runFfmpeg(ffmpeg, [
        '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', media.path, ...noiseInput(options, media.path),
        '-/filter_complex', 'probe.txt',
        '-map', '[o]', '-c:a', 'pcm_s16le', original,
        '-map', '[a]', '-c:a', 'pcm_s16le', processed,
      ], {
        cwd: tempDir,
        duration: length,
        signal: controller.signal,
        onProgress: (part) => progress('render', part),
      });
      return { ok: true, start, length, original: pathToFileURL(original).href, processed: pathToFileURL(processed).href };
    } catch (error) {
      if (error instanceof CanceledError || controller.signal.aborted) return { ok: false, canceled: true };
      return { ok: false, error: toGermanMessage(error) };
    } finally {
      if (previewRun === controller) previewRun = null;
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle('audio:cancelPreview', () => previewRun?.abort());

  ipcMain.handle('audio:start', async (_event, options) => {
    try {
      if (!options.folder) throw new UserError(t('Bitte wähle einen Zielordner.'));
      const media = await probeMedia(tools.path('ffprobe'), options.filePath);
      if (!media.hasAudio) throw new UserError(t('Diese Datei enthält keine Tonspur.'));
      checkOptions(options, media.duration);
      if (!hasEdits(options) && !(options.format in AUDIO_ONLY) && options.format !== 'original') {
        throw new UserError(t('Bitte wähle mindestens eine Bearbeitung oder ein Tonformat.'));
      }
      if (options.format === 'original' && hasEdits(options)) {
        throw new UserError(t('Die Original-Tonspur lässt sich nur ohne Bearbeitung übernehmen.'));
      }
      const info = await probeAudio(tools.path('ffprobe'), options.filePath);
      const jobId = queue.add({
        title: media.name,
        kind: 'audio',
        run: (job) => runAudio(options, media, info, job),
      });
      return { ok: true, jobId };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });
}

function dispose() {
  fsSync.rmSync(previewDir, { recursive: true, force: true });
}

module.exports = { register, dispose, snapSections, selectExpression };
