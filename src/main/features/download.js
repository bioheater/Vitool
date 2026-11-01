// Bereich Download: liest Videoinfos aus und lädt Videos oder Abschnitte mit yt-dlp.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { session } = require('electron');
const { run } = require('../core/process-runner');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { concatFiles } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');

const FILE_MARKER = 'VITOOLFILE|';
const PROGRESS_MARKER = 'VITOOLPROGRESS|';
const HISTORY_LIMIT = 200;
const SECTION_REQUEST_BYTES = 5_000_000;

function secondsToTime(value) {
  const total = Math.max(0, value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = (total % 60).toFixed(3).padStart(6, '0');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds}`;
}

function commonArgs(tools) {
  const args = ['--no-playlist', '--encoding', 'utf-8'];
  if (tools.path('deno')) args.push('--js-runtimes', `deno:${tools.path('deno')}`);
  return args;
}

// Bevorzugt eine direkte MP4-Datei. Viele Seiten liefern aber nur Streams aus Einzelstücken (HLS).
function pickPreview(formats) {
  const withPicture = formats
    .filter((format) => format.vcodec !== 'none' && format.acodec !== 'none')
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
  const smallest = (list) => list.find((format) => (format.height ?? 0) >= 360) ?? list.at(-1);

  const file = smallest(withPicture.filter((format) => format.ext === 'mp4' && /^https?$/.test(format.protocol ?? '')));
  if (file) return { url: file.url, kind: 'file', headers: file.http_headers };

  const stream = smallest(withPicture.filter((format) => (format.protocol ?? '').startsWith('m3u8')));
  return stream ? { url: stream.url, kind: 'hls', headers: stream.http_headers } : null;
}

function normalizeInfo(raw, url) {
  const info = raw.entries ? raw.entries.find(Boolean) : raw;
  if (!info) throw new UserError('Unter diesem Link wurde kein Video gefunden.');

  const formats = info.formats ?? [];
  const heights = [...new Set(
    formats.filter((format) => format.vcodec !== 'none' && format.height).map((format) => format.height),
  )].sort((a, b) => b - a);

  const preview = pickPreview(formats);

  return {
    url: info.webpage_url ?? url,
    title: info.title ?? 'Video',
    uploader: info.uploader ?? info.channel ?? null,
    duration: info.is_live ? null : info.duration ?? null,
    thumbnail: info.thumbnail ?? null,
    isLive: Boolean(info.is_live),
    heights,
    previewUrl: preview?.url ?? null,
    previewKind: preview?.kind ?? null,
    previewHeaders: preview?.headers ?? null,
  };
}

function buildArgs(options, tools, tempDir) {
  const { url, mode, height, sections, exact } = options;
  const hasSections = sections.length > 0;
  const name = hasSections
    ? '%(title).120B [%(section_start).1f-%(section_end).1f].%(ext)s'
    : '%(title).120B.%(ext)s';

  const args = [
    ...commonArgs(tools),
    '--ffmpeg-location', path.dirname(tools.path('ffmpegDownload') ?? tools.path('ffmpeg')),
    '--no-mtime',
    '--newline',
    '--progress',
    '--no-quiet',
    '--progress-template', `download:${PROGRESS_MARKER}%(progress._percent|)s|%(progress._speed_str|)s|%(progress._eta_str|)s`,
    '--print', `after_move:${FILE_MARKER}%(filepath)s`,
    '-P', tempDir,
    '-o', name,
  ];

  if (mode === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    // Die Auflösung muss zuerst stehen, sonst gewinnt H.264 auch bei niedriger Qualität.
    args.push('-f', 'bv*+ba/b', '-S', `${height ? `res:${height}` : 'res'},vcodec:h264,acodec:aac`);
    args.push('--merge-output-format', 'mp4');
  }

  sections.forEach(({ start, end }) => {
    args.push('--download-sections', `*${secondsToTime(start)}-${secondsToTime(end)}`);
  });
  // YouTube drosselt lange Anfragen stark, in kleinen Stücken lädt FFmpeg mit voller Geschwindigkeit.
  if (hasSections) args.push('--downloader-args', `ffmpeg_i:-request_size ${SECTION_REQUEST_BYTES}`);
  if (hasSections && exact) args.push('--force-keyframes-at-cuts');

  args.push('--', url);
  return args;
}

function validate(options) {
  if (!/^https?:\/\//i.test(options.url ?? '')) throw new UserError('Bitte gib einen gültigen Link ein.');
  if (!options.folder) throw new UserError('Bitte wähle einen Zielordner.');

  const seen = new Set();
  for (const { start, end } of options.sections) {
    if (!(end > start) || start < 0) throw new UserError('Bei einem Abschnitt liegt das Ende vor dem Start.');
    if (options.duration && end > options.duration + 1) {
      throw new UserError('Ein Abschnitt geht über das Ende des Videos hinaus.');
    }
    const key = `${start}-${end}`;
    if (seen.has(key)) throw new UserError('Zwei Abschnitte sind identisch. Entferne bitte einen davon.');
    seen.add(key);
  }
}

function mergedName(files) {
  const { name, ext } = path.parse(files[0]);
  return `${name.replace(/ \[[\d.]+-[\d.]+\]$/, '')} (zusammengefügt)${ext}`;
}

// Manche Seiten liefern Vorschau und Bild nur mit passender Herkunftsangabe aus.
function installPreviewHeaders() {
  const urls = ['http://*/*', 'https://*/*'];
  const streamTypes = ['xhr', 'fetch', 'media'];
  let current = null;

  const applies = ({ resourceType, url }) => current
    && (streamTypes.includes(resourceType) || (resourceType === 'image' && url === current.thumbnail));

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (applies(details)) {
      headers.Referer = current.referer;
      if (current.userAgent) headers['User-Agent'] = current.userAgent;
    }
    callback({ requestHeaders: headers });
  });

  // Der Stream-Player lädt die Stücke per Skript, dafür muss die Antwort das erlauben.
  session.defaultSession.webRequest.onHeadersReceived({ urls }, (details, callback) => {
    if (!current || !['xhr', 'fetch'].includes(details.resourceType)) {
      callback({});
      return;
    }
    const headers = Object.fromEntries(Object.entries(details.responseHeaders)
      .filter(([name]) => !name.toLowerCase().startsWith('access-control-allow-')));
    callback({ responseHeaders: { ...headers, 'Access-Control-Allow-Origin': ['*'] } });
  });

  return (info) => {
    current = {
      referer: info.url,
      userAgent: info.previewHeaders?.['User-Agent'] ?? null,
      thumbnail: info.thumbnail,
    };
  };
}

function register({ ipcMain, queue, store, tools, send }) {
  const setPreviewSource = installPreviewHeaders();
  const getHistory = () => store.get('history');

  function addHistory(entry) {
    store.set('history', [entry, ...getHistory()].slice(0, HISTORY_LIMIT));
    send('download:historyChanged', getHistory());
  }

  async function runDownload(options, job) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    const sectionCount = options.sections.length;
    const streamCount = options.mode === 'video' ? 2 : 1;
    const files = [];
    let finishedSections = 0;
    let stream = 0;
    let lastValue = 0;

    // Bei Abschnitten meldet yt-dlp nur das Ende eines Teils, die Zwischenstände kommen von FFmpeg.
    const onSectionProgress = (finishedPart) => {
      const current = Math.min(finishedSections + 1, sectionCount);
      job.update({
        progress: ((finishedSections + finishedPart) / sectionCount) * 100,
        detail: sectionCount > 1 ? `Abschnitt ${current} von ${sectionCount}` : 'Lädt Abschnitt',
      });
    };

    const onFfmpegTime = (line) => {
      const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (!match) return;
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      const section = options.sections[Math.min(finishedSections, sectionCount - 1)];
      onSectionProgress(Math.min(seconds / (section.end - section.start), 1));
    };

    // Video und Tonspur kommen getrennt, deshalb laufen die Prozente zweimal bis 100.
    const onStreamProgress = (value, speed, eta) => {
      if (value < lastValue) stream = Math.min(stream + 1, streamCount - 1);
      lastValue = value;
      const remaining = eta && eta !== 'Unknown' ? `noch ${eta}` : '';
      job.update({
        progress: ((stream + value / 100) / streamCount) * 100,
        detail: ['Lädt', speed.trim().replace('Unknown B/s', ''), remaining].filter(Boolean).join(' · '),
      });
    };

    const onLine = (line) => {
      if (line.startsWith(FILE_MARKER)) {
        files.push(line.slice(FILE_MARKER.length).trim());
      } else if (line.startsWith(PROGRESS_MARKER)) {
        const [percent, speed, eta] = line.slice(PROGRESS_MARKER.length).split('|');
        const value = Number.parseFloat(percent);
        if (!Number.isFinite(value)) return;
        if (!sectionCount) onStreamProgress(value, speed, eta);
        else if (value >= 100) {
          finishedSections += 1;
          onSectionProgress(0);
        }
      } else if (sectionCount) {
        onFfmpegTime(line);
      }
    };

    try {
      job.update({ detail: options.sections.length ? 'Lädt Abschnitte …' : 'Lädt …' });
      await run(tools.path('ytdlp'), buildArgs(options, tools, tempDir), { onLine, signal: job.signal });
      if (files.length === 0) throw new Error('Keine Datei erhalten');

      let results = files;
      if (options.merge && files.length > 1) {
        job.update({ detail: 'Fügt Abschnitte zusammen …', progress: null });
        const output = path.join(tempDir, mergedName(files));
        results = [await concatFiles(tools.path('ffmpeg'), files, output, job.signal)];
      }

      const saved = [];
      for (const file of results) saved.push(await moveFile(file, options.folder));

      addHistory({
        id: randomUUID(),
        title: options.title,
        thumbnail: options.thumbnail ?? null,
        url: options.url,
        mode: options.mode,
        files: saved,
        date: new Date().toISOString(),
      });
      if (options.openInCut) send('app:openInCut', saved[0]);
      return saved[0];
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  ipcMain.handle('download:info', async (_event, url) => {
    try {
      if (!/^https?:\/\//i.test(url ?? '')) throw new UserError('Bitte gib einen gültigen Link ein.');
      const args = [...commonArgs(tools), '-J', '--no-warnings', '--playlist-items', '1', '--', url];
      const { stdout } = await run(tools.path('ytdlp'), args);
      const info = normalizeInfo(JSON.parse(stdout), url);
      setPreviewSource(info);
      return { ok: true, info };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  ipcMain.handle('download:start', (_event, options) => {
    try {
      validate(options);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    queue.add({
      title: options.title,
      kind: 'download',
      run: (job) => runDownload(options, job),
    });
    return { ok: true };
  });

  ipcMain.handle('download:history', () => getHistory());
  ipcMain.handle('download:clearHistory', () => {
    store.set('history', []);
    return [];
  });
}

module.exports = { register, buildArgs, normalizeInfo };
