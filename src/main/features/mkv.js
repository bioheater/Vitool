// Bereich MKV: Spuren ansehen, auswählen, benennen, hinzufügen und einzeln herausholen.
// Alles läuft ohne Neukodierung, die Qualität bleibt also unverändert.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { run } = require('../core/process-runner');
const { runFfmpeg } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');
const { t } = require('../core/i18n');

const EXTRACT_EXTENSIONS = {
  subrip: 'srt', ass: 'ass', ssa: 'ssa', webvtt: 'vtt', mov_text: 'srt',
  aac: 'm4a', mp3: 'mp3', ac3: 'ac3', eac3: 'eac3', dts: 'dts', flac: 'flac', opus: 'opus', vorbis: 'ogg', truehd: 'thd',
};
const FALLBACK_EXTENSIONS = { video: 'mkv', audio: 'mka', subtitle: 'mks' };
const CHANNEL_NAMES = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' };

function describeTrack(stream) {
  if (stream.codec_type === 'video') return `${stream.width} × ${stream.height}`;
  if (stream.codec_type === 'audio') return CHANNEL_NAMES[stream.channels] ?? t('{count} Kanäle', { count: stream.channels });
  return '';
}

function toTrack(stream, source) {
  return {
    source,
    index: stream.index,
    type: stream.codec_type,
    codec: stream.codec_name ?? 'unbekannt',
    info: describeTrack(stream),
    language: stream.tags?.language ?? 'und',
    name: stream.tags?.title ?? '',
    isDefault: stream.disposition?.default === 1,
    forced: stream.disposition?.forced === 1,
    keep: true,
  };
}

async function readTracks(ffprobe, filePath) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const { streams, format } = JSON.parse(stdout);
  const usable = streams.filter((stream) =>
    ['video', 'audio', 'subtitle'].includes(stream.codec_type) && !stream.disposition?.attached_pic);
  if (usable.length === 0) throw new UserError(t('In dieser Datei wurden keine Spuren gefunden.'));
  return { title: format.tags?.title ?? '', streams: usable };
}

function trackArgs(track, outputIndex) {
  const flags = [track.isDefault && 'default', track.forced && 'forced'].filter(Boolean).join('+') || '0';
  const args = [
    '-map', `${track.source}:${track.index}`,
    `-metadata:s:${outputIndex}`, `language=${track.language}`,
    `-metadata:s:${outputIndex}`, `title=${track.name}`,
    `-disposition:${outputIndex}`, flags,
  ];
  return args;
}

function register({ ipcMain, queue, tools }) {
  ipcMain.handle('mkv:read', async (_event, filePath, source = 0) => {
    try {
      const { title, streams } = await readTracks(tools.path('ffprobe'), filePath);
      return { ok: true, title, tracks: streams.map((stream) => toTrack(stream, source)) };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  async function runSave(options, kept, job) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    const output = path.join(tempDir, 'ergebnis.mkv');
    const inputs = options.files.flatMap((file) => ['-i', file]);
    const name = path.parse(options.files[0]).name;

    try {
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
      return await moveFile(output, options.folder, `${name} (bearbeitet).mkv`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('mkv:save', (_event, options) => {
    const kept = options.tracks.filter((track) => track.keep);
    if (kept.length === 0) return { ok: false, error: t('Bitte behalte mindestens eine Spur.') };
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
      await runFfmpeg(tools.path('ffmpeg'), ['-i', options.filePath, '-map', `0:${track.index}`, ...codec, output], { signal: job.signal });
      return await moveFile(output, options.folder, `${name} (${t('Spur {number}', { number: track.index + 1 })}${language}).${ext}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('mkv:extract', (_event, options) => {
    queue.add({
      title: t('Spur {number}: {name}', { number: options.track.index + 1, name: path.basename(options.filePath) }),
      kind: 'mkv',
      run: (job) => runExtract(options, job),
    });
    return { ok: true };
  });
}

module.exports = { register };
