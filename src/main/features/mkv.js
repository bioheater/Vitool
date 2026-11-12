// Bereich MKV: Spuren ansehen, auswählen, benennen, hinzufügen und einzeln herausholen.
// Alles läuft ohne Neukodierung, die Qualität bleibt also unverändert.
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { run } = require('../core/process-runner');
const { runFfmpeg } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');
const { t } = require('../core/i18n');
const { analyzeSync, readEnvelope } = require('../core/audio-sync');

const EXTRACT_EXTENSIONS = {
  subrip: 'srt', ass: 'ass', ssa: 'ssa', webvtt: 'vtt', mov_text: 'srt',
  aac: 'm4a', mp3: 'mp3', ac3: 'ac3', eac3: 'eac3', dts: 'dts', flac: 'flac', opus: 'opus', vorbis: 'ogg', truehd: 'thd',
};
const FALLBACK_EXTENSIONS = { video: 'mkv', audio: 'mka', subtitle: 'mks' };
const CHANNEL_NAMES = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' };
const MAX_OFFSET = 3600;
const LOSSLESS = /^(flac|truehd|mlp|alac|pcm_)/;
const previewDir = path.join(os.tmpdir(), `vitool-abgleich-${process.pid}`);

// Eine Spur mit anderem Tempo oder anderer Lautstärke muss neu kodiert werden. Verlustfreie Spuren bleiben verlustfrei,
// Kino-Formate werden AC3, alles andere AAC. Die Bitrate orientiert sich an der Quelle.
function audioEncoder({ codec, channels, bitRate }) {
  const kbit = bitRate ? Math.round(bitRate / 1000) : null;
  if (LOSSLESS.test(codec) || channels > 6) return { args: ['-c:a', 'flac'], label: 'FLAC' };
  if (/^(ac3|eac3|dts)/.test(codec)) {
    const rate = channels > 2 ? 640 : Math.min(448, Math.max(192, kbit ?? 256));
    return { args: ['-c:a', 'ac3', '-b:a', `${rate}k`], label: `AC3 · ${rate} kbit/s` };
  }
  const rate = Math.min(512, Math.max(64 * (channels ?? 2), kbit ?? 96 * (channels ?? 2)));
  return { args: ['-c:a', 'aac', '-b:a', `${rate}k`], label: `AAC · ${rate} kbit/s` };
}

// Dehnt die Spur um den Faktor stretch, Tonhöhe inklusive, so wie beim Umrechnen zwischen 25 und 24
// Bildern pro Sekunde. asetrate kennt nur ganze Zahlen. Deshalb wird vorher auf eine Rate gebracht,
// bei der das Verhältnis aufgeht. Sonst summiert sich der Rundungsfehler über einen Film auf.
function retimeFilter(sampleRate, stretch) {
  let best = { rate: sampleRate, error: Infinity };
  for (let rate = sampleRate; rate <= sampleRate * 4; rate += 1) {
    const target = rate / stretch;
    const error = Math.abs(Math.round(target) / target - 1);
    if (error < best.error) best = { rate, error };
    if (error < 1e-9) break;
  }
  return `aresample=${best.rate},asetrate=${Math.round(best.rate / stretch)},aresample=${sampleRate}`;
}

function isRetimed(track) {
  return track.type === 'audio' && Math.abs((track.stretch ?? 1) - 1) > 1e-6;
}

function hasGain(track) {
  return track.type === 'audio' && Math.abs(track.gain ?? 0) >= 0.05;
}

// Alle Tonfilter einer Spur in der Reihenfolge Tempo, Lautstärke, Begrenzer. Wird lauter gemacht,
// fängt der Begrenzer die Spitzen bei −2 dB ab, mit Abstand zum Maximum, statt sie hart abzuschneiden.
// "level=0" schaltet seine eigene Pegelautomatik ab, "latency=1" gleicht seine Verzögerung aus.
function audioFilters(track, stretch = track.stretch ?? 1) {
  const filters = [];
  if (Math.abs(stretch - 1) > 1e-6 && track.sampleRate) filters.push(retimeFilter(track.sampleRate, stretch));
  if (hasGain(track)) {
    filters.push(`volume=${track.gain}dB`);
    if (track.gain > 0) filters.push('alimiter=limit=0.794:level=0:latency=1');
  }
  return filters;
}

// Integrierte Lautheit (LUFS) und echte Spitze (dBTP) nach EBU R128, aus der Zusammenfassung von ebur128.
function parseLoudness(text) {
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const integrated = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(summary);
  const peak = /Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(summary);
  const value = (match) => (match && match[1] !== '-inf' ? Number(match[1]) : null);
  return { loudness: value(integrated), peak: value(peak) };
}

// Matroska speichert die Länge einer Spur als Text, etwa "01:52:03.456000000".
function streamDuration(stream, fallback) {
  const direct = Number(stream.duration);
  if (direct > 0) return direct;
  const tag = Object.entries(stream.tags ?? {}).find(([key]) => /^duration/i.test(key))?.[1];
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(tag ?? '');
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : fallback;
}

function describeTrack(stream) {
  if (stream.codec_type === 'video') return `${stream.width} × ${stream.height}`;
  if (stream.codec_type === 'audio') return CHANNEL_NAMES[stream.channels] ?? t('{count} Kanäle', { count: stream.channels });
  return '';
}

function toTrack(stream, source, fileDuration) {
  const bitRate = Number(stream.bit_rate || stream.tags?.BPS || stream.tags?.['BPS-eng']) || null;
  return {
    duration: streamDuration(stream, fileDuration),
    sampleRate: Number(stream.sample_rate) || null,
    channels: stream.channels ?? null,
    bitRate,
    stretch: 1,
    gain: 0,
    encodeLabel: stream.codec_type === 'audio'
      ? audioEncoder({ codec: stream.codec_name ?? '', channels: stream.channels, bitRate }).label
      : null,
    source,
    index: stream.index,
    type: stream.codec_type,
    codec: stream.codec_name ?? 'unbekannt',
    info: describeTrack(stream),
    language: stream.tags?.language ?? 'und',
    name: stream.tags?.title ?? '',
    isDefault: stream.disposition?.default === 1,
    forced: stream.disposition?.forced === 1,
    offset: 0,
    keep: true,
  };
}

async function readTracks(ffprobe, filePath) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const { streams, format } = JSON.parse(stdout);
  const usable = streams.filter((stream) =>
    ['video', 'audio', 'subtitle'].includes(stream.codec_type) && !stream.disposition?.attached_pic);
  if (usable.length === 0) throw new UserError(t('In dieser Datei wurden keine Spuren gefunden.'));
  return { title: format.tags?.title ?? '', streams: usable, duration: Number(format.duration) || null };
}

function trackArgs(track, outputIndex) {
  const flags = [track.isDefault && 'default', track.forced && 'forced'].filter(Boolean).join('+') || '0';
  const args = [
    '-map', track.shifted ?? `${track.source}:${track.index}`,
    `-metadata:s:${outputIndex}`, `language=${track.language}`,
    `-metadata:s:${outputIndex}`, `title=${track.name}`,
    `-disposition:${outputIndex}`, flags,
  ];
  return args;
}

function register({ ipcMain, queue, tools, send }) {
  ipcMain.handle('mkv:read', async (_event, filePath, source = 0) => {
    try {
      const { title, streams, duration } = await readTracks(tools.path('ffprobe'), filePath);
      return { ok: true, title, tracks: streams.map((stream) => toTrack(stream, source, duration)) };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  // Eine verschobene Spur kommt zuerst in eine eigene Datei. Nur so lässt sich ihr Anfang
  // abschneiden, ohne neu zu kodieren: In der ganzen Datei würde FFmpeg zum letzten Schlüsselbild
  // des Videos springen und gar nicht verschieben. Später beginnen geht über einen Zeitversatz.
  async function shiftTracks(options, kept, tempDir, job) {
    const inputs = options.files.flatMap((file) => ['-i', file]);
    let next = options.files.length;
    for (const track of kept.filter((entry) => entry.offset || isRetimed(entry) || hasGain(entry))) {
      const retimed = isRetimed(track);
      const encoded = retimed || hasGain(track);
      let detail = t('Verschiebt Spur {number}', { number: track.index + 1 });
      if (retimed) detail = t('Passt Tempo von Spur {number} an', { number: track.index + 1 });
      else if (encoded) detail = t('Ändert Lautstärke von Spur {number}', { number: track.index + 1 });
      job.update({ detail, progress: encoded ? 0 : null });
      const file = path.join(tempDir, `spur-${next}.mkv`);
      const cut = track.offset < 0 ? ['-ss', String(-track.offset)] : [];
      let codec = track.codec === 'mov_text' ? ['-c', 'srt'] : ['-c', 'copy'];
      if (encoded) codec = ['-af', audioFilters(track).join(','), ...audioEncoder(track).args];
      await runFfmpeg(tools.path('ffmpeg'), ['-i', options.files[track.source], '-map', `0:${track.index}`, ...codec, ...cut, file], {
        signal: job.signal,
        duration: encoded ? (track.duration ?? 0) * track.stretch : 0,
        onProgress: (part) => job.update({ progress: part * 100 }),
      });
      inputs.push(...(track.offset > 0 ? ['-itsoffset', String(track.offset)] : []), '-i', file);
      track.shifted = `${next}:0`;
      next += 1;
    }
    return inputs;
  }

  async function runSave(options, kept, job) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    const output = path.join(tempDir, 'ergebnis.mkv');
    const name = path.parse(options.files[0]).name;

    try {
      const inputs = await shiftTracks(options, kept, tempDir, job);
      job.update({ detail: t('Speichert Spuren') });
      await runFfmpeg(tools.path('ffmpeg'), [
        ...inputs,
        '-map_chapters', '0',
        ...kept.flatMap(trackArgs),
        '-map', '0:t?',
        '-c', 'copy',
        // MP4-Untertitel lassen sich nicht direkt in MKV übernehmen.
        ...kept.flatMap((track, index) => (track.codec === 'mov_text' ? [`-c:${index}`, 'srt'] : [])),
        '-metadata', `title=${options.title}`,
        output,
      ], { signal: job.signal });
      return await moveFile(output, options.folder, `${name} (${t('bearbeitet')}).mkv`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('mkv:save', (_event, options) => {
    const kept = options.tracks.filter((track) => track.keep);
    if (kept.length === 0) return { ok: false, error: t('Bitte behalte mindestens eine Spur.') };
    kept.forEach((track) => {
      const offset = Number(track.offset) || 0;
      track.offset = track.type === 'video' ? 0 : Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, offset));
      const stretch = Number(track.stretch) || 1;
      track.stretch = track.type === 'audio' && track.sampleRate && stretch > 0.8 && stretch < 1.25 ? stretch : 1;
      const gain = Math.round((Number(track.gain) || 0) * 10) / 10;
      track.gain = track.type === 'audio' ? Math.max(-30, Math.min(30, gain)) : 0;
    });
    if (!options.folder) return { ok: false, error: t('Bitte wähle einen Zielordner.') };
    queue.add({
      title: path.basename(options.files[0]),
      kind: 'mkv',
      run: (job) => runSave(options, kept, job),
    });
    return { ok: true };
  });

  async function runExtract(options, job) {
    const { track } = options;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    const ext = EXTRACT_EXTENSIONS[track.codec] ?? FALLBACK_EXTENSIONS[track.type];
    const output = path.join(tempDir, `ergebnis.${ext}`);
    const codec = track.codec === 'mov_text' ? ['-c', 'srt'] : ['-c', 'copy'];
    const language = track.language === 'und' ? '' : ` ${track.language}`;
    const name = path.parse(options.filePath).name;

    try {
      job.update({ detail: t('Holt Spur heraus') });
      const format = ext === 'mks' ? ['-f', 'matroska'] : [];
      await runFfmpeg(tools.path('ffmpeg'), ['-i', options.filePath, '-map', `0:${track.index}`, ...codec, ...format, output], { signal: job.signal });
      return await moveFile(output, options.folder, `${name} (${t('Spur {number}', { number: track.index + 1 })}${language}).${ext}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Lautstärkeverlauf eines Ausschnitts für die Wellenform.
  ipcMain.handle('mkv:waveform', async (_event, { file, index, start, duration, bin }) => {
    try {
      const values = await readEnvelope(tools.path('ffmpeg'), file, index, start, duration, bin);
      return { ok: true, values };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  let analysis = null;
  ipcMain.handle('mkv:analyzeSync', async (_event, { reference, track }) => {
    analysis?.abort();
    const controller = new AbortController();
    analysis = controller;
    try {
      const result = await analyzeSync(tools.path('ffmpeg'), reference, track, {
        signal: controller.signal,
        onProgress: (part) => send('mkv:syncProgress', { part }),
      });
      return { ok: true, result };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, canceled: true };
      return { ok: false, error: toGermanMessage(error) };
    } finally {
      if (analysis === controller) analysis = null;
    }
  });

  // Misst eine ganze Spur. Das Ergebnis bleibt gespeichert, damit ein zweiter Vergleich sofort geht.
  const loudnessCache = new Map();
  ipcMain.handle('mkv:loudness', async (_event, { file, index, duration }) => {
    const key = `${file}|${index}`;
    try {
      if (!loudnessCache.has(key)) {
        const { stderr } = await runFfmpeg(tools.path('ffmpeg'), [
          '-i', file, '-map', `0:${index}`, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-',
        ], {
          duration,
          onProgress: (part) => send('mkv:loudnessProgress', { file, index, part }),
        });
        const result = parseLoudness(stderr);
        if (result.loudness === null) throw new UserError(t('In dieser Spur ist nur Stille.'));
        loudnessCache.set(key, result);
      }
      return { ok: true, ...loudnessCache.get(key) };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  // Kurzer Probeclip: Bild aus dem Video, Ton aus der Spur mit Versatz und Tempo wie beim Speichern.
  ipcMain.handle('mkv:syncPreview', async (_event, { video, track, start, length }) => {
    try {
      await fs.rm(previewDir, { recursive: true, force: true });
      await fs.mkdir(previewDir, { recursive: true });
      const output = path.join(previewDir, `probe-${Date.now()}.mp4`);
      const stretch = Number(track.stretch) || 1;
      let seek = (start - track.offset) / stretch;
      let delay = 0;
      if (seek < 0) {
        delay = -seek * stretch;
        seek = 0;
      }
      const filters = [
        ...audioFilters({ type: 'audio', ...track, gain: Number(track.gain) || 0 }, stretch),
        ...(delay > 0 ? [`adelay=${Math.round(delay * 1000)}:all=1`] : []),
      ];
      await runFfmpeg(tools.path('ffmpeg'), [
        '-ss', String(Math.max(0, start)), '-t', String(length), '-i', video.file,
        '-ss', seek.toFixed(3), '-i', track.file,
        '-map', `0:${video.index}`, '-map', `1:${track.index}`,
        '-vf', 'scale=-2:2*trunc(min(480\\,ih)/2)',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
        ...(filters.length ? ['-af', filters.join(',')] : []),
        '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-t', String(length), '-movflags', '+faststart', output,
      ]);
      return { ok: true, url: pathToFileURL(output).href };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  ipcMain.handle('mkv:extract', (_event, options) => {
    queue.add({
      title: t('Spur {number}: {name}', { number: options.track.index + 1, name: path.basename(options.filePath) }),
      kind: 'mkv',
      run: (job) => runExtract(options, job),
    });
    return { ok: true };
  });
}

function dispose() {
  fsSync.rmSync(previewDir, { recursive: true, force: true });
}

module.exports = { register, dispose, retimeFilter, audioEncoder, audioFilters, parseLoudness };
