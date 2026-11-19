// FFmpeg-Aufrufe, die mehrere Bereiche brauchen.
const fs = require('fs/promises');
const path = require('path');
const { run } = require('./process-runner');
const { UserError } = require('./error-messages');
const { t } = require('./i18n');

// onProgress erhält den Anteil von 0 bis 1, bezogen auf die Länge des Ergebnisses.
function runFfmpeg(ffmpeg, args, { duration, onProgress, signal, cwd, writeInput } = {}) {
  const onLine = (line) => {
    const match = /^out_time_us=(\d+)/.exec(line);
    if (match && duration) onProgress?.(Math.min(Number(match[1]) / 1e6 / duration, 1));
  };
  const fullArgs = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
  return run(ffmpeg, fullArgs, { onLine, signal, cwd, writeInput });
}

async function concatFiles(ffmpeg, files, output, signal) {
  const listPath = path.join(path.dirname(output), 'liste.txt');
  const list = files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listPath, list, 'utf8');
  await runFfmpeg(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output], { signal });
  return output;
}

function parseFps(rate) {
  const [numerator, denominator] = String(rate).split('/').map(Number);
  return numerator && denominator ? numerator / denominator : 30;
}

// Bitrate einer Spur in bit/s. MKV und WebM nennen sie nur in den Tags ("BPS").
function streamBitRate(stream) {
  return Number(stream.bit_rate || stream.tags?.BPS || stream.tags?.['BPS-eng']) || 0;
}

// Bitrate des Bildes in kbit/s. Fehlt sie, bleibt der Rest der Datei nach Abzug des Tons.
function videoKbps(video, format, duration, audioBits) {
  const direct = streamBitRate(video);
  if (direct) return Math.round(direct / 1000);
  const total = Number(format.bit_rate) || (Number(format.size) * 8) / duration;
  const rest = total - audioBits;
  return rest > 0 && Number.isFinite(rest) ? Math.round(rest / 1000) : null;
}

// Bitrate des Tons in kbit/s. Bei reinen Tondateien zur Not aus der Größe der Datei.
function audioKbps(audio, format, duration, hasVideo) {
  const direct = streamBitRate(audio);
  if (direct) return Math.round(direct / 1000);
  if (hasVideo) return null;
  const total = Number(format.bit_rate) || (Number(format.size) * 8) / duration;
  return Number.isFinite(total) && total > 0 ? Math.round(total / 1000) : null;
}

async function probeMedia(ffprobe, filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new UserError(t('Diese Datei wurde nicht gefunden. Vielleicht wurde sie verschoben.'));
  }

  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ]);
  const { format, streams } = JSON.parse(stdout);
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(format.duration);
  const audioBits = streams.filter((stream) => stream.codec_type === 'audio').reduce((sum, stream) => sum + streamBitRate(stream), 0);

  if ((!video && !audio) || !duration) {
    throw new UserError(t('Diese Datei enthält kein lesbares Video oder Audio.'));
  }

  // Handyvideos sind oft gedreht gespeichert, angezeigt wird aber die gedrehte Größe.
  const rotation = video?.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? 0;
  const sideways = Math.abs(rotation) % 180 === 90;

  return {
    path: filePath,
    name: path.basename(filePath),
    duration,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    size: Number(format.size),
    width: (sideways ? video?.height : video?.width) ?? null,
    height: (sideways ? video?.width : video?.height) ?? null,
    fps: parseFps(video?.avg_frame_rate),
    videoCodec: video?.codec_name ?? null,
    videoKbps: video ? videoKbps(video, format, duration, audioBits) : null,
    audioKbps: audio ? audioKbps(audio, format, duration, Boolean(video)) : null,
    audioChannels: audio?.channels ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

// Kodieren über die NVIDIA-Grafikkarte (NVENC) entlastet den Prozessor stark. Ob es geht, zeigt ein
// Probelauf mit einem einzigen Bild; ohne passende Karte oder Treiber bleibt es beim Prozessor (x264).
let gpuEncoderCheck = null;

function hasGpuEncoder(ffmpeg) {
  gpuEncoderCheck ??= run(ffmpeg, [
    '-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1',
    '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-',
  ]).then(() => true, () => false);
  return gpuEncoderCheck;
}

// Mehr als die Quelle hergibt, bringt beim Neukodieren keine bessere Qualität, nur eine größere Datei.
// Gerade Videos von YouTube sind stark komprimiert und wurden mit fester Qualität bis zu fünfmal so groß.
// Deshalb darf das Ergebnis nur wenig über der Bitrate der Quelle liegen. Ein Mindestwert schützt
// sehr kleine Quellen davor, dass das Bild durch das erneute Kodieren sichtbar schlechter wird.
const BITRATE_HEADROOM = 1.15;
const MIN_BITRATE_KBPS = 600;

function bitrateCap(sourceKbps) {
  if (!(sourceKbps > 0)) return [];
  const cap = Math.max(MIN_BITRATE_KBPS, Math.round(sourceKbps * BITRATE_HEADROOM));
  return ['-maxrate', `${cap}k`, '-bufsize', `${cap * 2}k`];
}

// Ton beim Neukodieren: so viel wie die Quelle, auf die nächste übliche Stufe aufgerundet. Höchstens
// das bisher Übliche (192 kbit/s, bei Surround 384), mehr bringt hörbar nichts. Ohne Angabe gilt die Obergrenze.
const AUDIO_STEPS = [64, 96, 128, 160, 192, 256, 320, 384];

function audioKbpsFor(media, ceiling = 192) {
  const limit = (media?.audioChannels ?? 2) > 2 ? Math.max(ceiling, 384) : ceiling;
  const source = media?.audioKbps;
  if (!(source > 0)) return limit;
  const step = AUDIO_STEPS.find((value) => value >= source * 0.97) ?? limit;
  return Math.min(limit, step);
}

// Qualität wie bisher bei x264 mit CRF 18, aber höchstens etwas über der Bitrate der Quelle.
async function videoEncoderArgs(ffmpeg, { sourceKbps = null } = {}) {
  const cap = bitrateCap(sourceKbps);
  if (await hasGpuEncoder(ffmpeg)) {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', '0', ...cap, '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', ...cap, '-pix_fmt', 'yuv420p'];
}

module.exports = { runFfmpeg, concatFiles, probeMedia, videoEncoderArgs, bitrateCap, audioKbpsFor };
