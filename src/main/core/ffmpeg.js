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

// Qualität wie bisher bei x264 mit CRF 18.
async function videoEncoderArgs(ffmpeg) {
  if (await hasGpuEncoder(ffmpeg)) {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
}

module.exports = { runFfmpeg, concatFiles, probeMedia, videoEncoderArgs };
