// Bereich Download: liest Videoinfos aus und lädt Videos oder Abschnitte mit yt-dlp.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { BrowserWindow, session } = require('electron');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { concatFiles } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');
const { t } = require('../core/i18n');
const { createPageFinder } = require('./page-finder');

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

// Herkunft, Browserkennung und Cookies, die eine gefundene Seite für ihren Stream verlangt.
function headerArgs(headers) {
  return Object.entries(headers ?? {}).flatMap(([name, value]) => ['--add-header', `${name}:${value}`]);
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
  // Reiner Playlist-Link oder ein Video, das zu einer Playlist gehört (YouTube: "list=" im Link).
  const playlist = raw._type === 'playlist' ? 'only' : /[?&]list=/.test(url) ? 'member' : null;
  if (!info) {
    if (playlist) return { url, title: raw.title ?? t('Playlist'), playlist: 'only', heights: [] };
    const error = new UserError(t('Unter diesem Link wurde kein Video gefunden.'));
    error.noVideo = true;
    throw error;
  }

  const formats = info.formats ?? [];
  const heights = [...new Set(
    formats.filter((format) => format.vcodec !== 'none' && format.height).map((format) => format.height),
  )].sort((a, b) => b - a);

  const preview = pickPreview(formats);

  return {
    url: info.webpage_url ?? url,
    title: info.title ?? t('Video'),
    uploader: info.uploader ?? info.channel ?? null,
    duration: info.is_live ? null : info.duration ?? null,
    thumbnail: info.thumbnail ?? null,
    isLive: Boolean(info.is_live),
    heights,
    previewUrl: preview?.url ?? null,
    previewKind: preview?.kind ?? null,
    previewHeaders: preview?.headers ?? null,
    playlist,
  };
}

const UNAVAILABLE_TITLES = ['[Private video]', '[Deleted video]', '[Unavailable video]'];

// Manche Seiten liefern in der schnellen Liste keine Titel. Dann hilft der lesbare Teil des Links.
function titleFromUrl(url) {
  try {
    const slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    if (!/[a-z]{3}/i.test(slug) || /^[\w-]{11}$/.test(slug) && !slug.includes('_')) return null;
    const words = slug.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_-]+/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : null;
  } catch {
    return null;
  }
}

// Listet die Videos einer Playlist, ohne jedes einzeln abzufragen. Das geht auch bei langen Listen schnell.
function normalizePlaylist(raw, url) {
  const entries = (raw.entries ?? []).filter(Boolean).map((entry, index) => {
    const entryUrl = entry.url ?? entry.webpage_url ?? null;
    return {
      index: index + 1,
      url: entryUrl,
      title: entry.title || titleFromUrl(entryUrl) || t('Video {number}', { number: index + 1 }),
      duration: entry.duration ?? null,
      thumbnail: entry.thumbnails?.at(-1)?.url ?? entry.thumbnail ?? null,
      available: Boolean(entryUrl) && !UNAVAILABLE_TITLES.includes(entry.title),
    };
  });
  if (entries.length === 0) throw new UserError(t('In dieser Playlist wurden keine Videos gefunden.'));
  return {
    url: raw.webpage_url ?? url,
    title: raw.title ?? t('Playlist'),
    uploader: raw.uploader ?? raw.channel ?? null,
    entries,
  };
}

function safeFolderName(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim().slice(0, 120) || 'Playlist';
}

function buildArgs(options, tools, tempDir) {
  const { url, mode, height, sections, exact, headers } = options;
  const hasSections = sections.length > 0;
  // Ein auf der Seite gefundener Stream heißt meist nur "master", der Titel kommt dann von der Seite.
  const title = options.pageUrl && options.title ? safeFolderName(options.title).replace(/%/g, '%%') : '%(title).120B';
  const name = hasSections
    ? `${title} [%(section_start).1f-%(section_end).1f].%(ext)s`
    : `${title}.%(ext)s`;

  const args = [
    ...commonArgs(tools),
    ...headerArgs(headers),
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
  if (!/^https?:\/\//i.test(options.url ?? '')) throw new UserError(t('Bitte gib einen gültigen Link ein.'));
  if (!options.folder) throw new UserError(t('Bitte wähle einen Zielordner.'));

  const seen = new Set();
  for (const { start, end } of options.sections) {
    if (!(end > start) || start < 0) throw new UserError(t('Bei einem Abschnitt liegt das Ende vor dem Start.'));
    if (options.duration && end > options.duration + 1) {
      throw new UserError(t('Ein Abschnitt geht über das Ende des Videos hinaus.'));
    }
    const key = `${start}-${end}`;
    if (seen.has(key)) throw new UserError(t('Zwei Abschnitte sind identisch. Entferne bitte einen davon.'));
    seen.add(key);
  }
}

function mergedName(files) {
  const { name, ext } = path.parse(files[0]);
  return `${name.replace(/ \[[\d.]+-[\d.]+\]$/, '')} (${t('zusammengefügt')})${ext}`;
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
      referer: info.previewHeaders?.Referer ?? info.url,
      userAgent: info.previewHeaders?.['User-Agent'] ?? null,
      thumbnail: info.thumbnail,
    };
  };
}

function register({ ipcMain, queue, store, tools, send, ytdlp }) {
  const setPreviewSource = installPreviewHeaders();
  const finder = createPageFinder({ send });
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
    // Ein neuer Versuch beginnt bei null, sonst stimmen Dateiliste und Fortschritt nicht.
    const reset = () => {
      files.length = 0;
      finishedSections = 0;
      stream = 0;
      lastValue = 0;
    };

    // Bei Abschnitten meldet yt-dlp nur das Ende eines Teils, die Zwischenstände kommen von FFmpeg.
    const onSectionProgress = (finishedPart) => {
      const current = Math.min(finishedSections + 1, sectionCount);
      job.update({
        progress: ((finishedSections + finishedPart) / sectionCount) * 100,
        detail: sectionCount > 1 ? t('Abschnitt {number} von {total}', { number: current, total: sectionCount }) : t('Lädt Abschnitt'),
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
      const remaining = eta && eta !== 'Unknown' ? t('noch {time}', { time: eta }) : '';
      job.update({
        progress: ((stream + value / 100) / streamCount) * 100,
        detail: [t('Lädt'), speed.trim().replace('Unknown B/s', ''), remaining].filter(Boolean).join(' · '),
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
      job.update({ detail: options.sections.length ? t('Lädt Abschnitte …') : t('Lädt …') });
      await ytdlp.run(buildArgs(options, tools, tempDir), {
        onLine,
        signal: job.signal,
        // Streams von einer gefundenen Seite bringen ihre eigenen Cookies mit.
        signIn: !options.pageUrl,
        onStatus: (detail, retrying) => {
          if (retrying) reset();
          job.update({ detail, progress: null });
        },
      });
      if (files.length === 0) throw new Error(t('Keine Datei erhalten'));

      let results = files;
      if (options.merge && files.length > 1) {
        job.update({ detail: t('Fügt Abschnitte zusammen …'), progress: null });
        const output = path.join(tempDir, mergedName(files));
        results = [await concatFiles(tools.path('ffmpeg'), files, output, job.signal)];
      }

      const saved = [];
      for (const file of results) saved.push(await moveFile(file, options.folder));

      addHistory({
        id: randomUUID(),
        title: options.title,
        thumbnail: options.thumbnail ?? null,
        url: options.pageUrl ?? options.url,
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

  async function readInfo(url, source = null) {
    if (!/^https?:\/\//i.test(url ?? '')) throw new UserError(t('Bitte gib einen gültigen Link ein.'));
    const args = [...commonArgs(tools), ...headerArgs(source?.headers), '-J', '--no-warnings', '--playlist-items', '1', '--', url];
    const { stdout } = await ytdlp.run(args, { signIn: !source });
    const info = normalizeInfo(JSON.parse(stdout), url);
    if (source) {
      // Der Stream heißt meist nur "master" oder "index", die Seite hat den lesbaren Titel.
      Object.assign(info, { title: source.title || info.title, headers: source.headers, pageUrl: source.pageUrl, playlist: null });
    }
    setPreviewSource(info);
    return info;
  }

  ipcMain.handle('download:info', async (_event, url) => {
    try {
      return { ok: true, info: await readInfo(url) };
    } catch (error) {
      // Kennt yt-dlp die Seite nicht, kann Vitool das Video noch beim Abspielen auf der Seite finden.
      const canSearchPage = /unsupported url/i.test(String(error?.message)) || error?.noVideo === true;
      return { ok: false, error: toGermanMessage(error), canSearchPage, fix: error?.fix ?? null };
    }
  });

  ipcMain.handle('download:findOnPage', (event, url) => {
    if (!/^https?:\/\//i.test(url ?? '')) return { ok: false, error: t('Bitte gib einen gültigen Link ein.') };
    finder.open(url, BrowserWindow.fromWebContents(event.sender));
    return { ok: true };
  });

  ipcMain.handle('download:fromPage', async (_event, id) => {
    try {
      const source = await finder.take(id);
      if (!source) throw new UserError(t('Dieses Video ist nicht mehr in der Liste. Spiele es bitte noch einmal ab.'));
      const info = await readInfo(source.url, source);
      finder.close();
      return { ok: true, info };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  ipcMain.handle('download:closeFinder', () => finder.close());

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

  ipcMain.handle('download:playlist', async (_event, url) => {
    try {
      if (!/^https?:\/\//i.test(url ?? '')) throw new UserError(t('Bitte gib einen gültigen Link ein.'));
      const base = commonArgs(tools).filter((arg) => arg !== '--no-playlist');
      const args = [...base, '-J', '--flat-playlist', '--yes-playlist', '--no-warnings', '--', url];
      const { stdout } = await ytdlp.run(args);
      return { ok: true, playlist: normalizePlaylist(JSON.parse(stdout), url) };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error), fix: error?.fix ?? null };
    }
  });

  // Jedes Video wird ein eigener Auftrag und erscheint einzeln im Verlauf.
  ipcMain.handle('download:playlistStart', async (_event, options) => {
    try {
      if (!options.folder) throw new UserError(t('Bitte wähle einen Zielordner.'));
      if (!options.entries?.length) throw new UserError(t('Bitte wähle mindestens ein Video aus.'));
      const folder = options.subfolder ? path.join(options.folder, safeFolderName(options.playlistTitle)) : options.folder;
      await fs.mkdir(folder, { recursive: true });
      options.entries.forEach((entry) => {
        const single = {
          url: entry.url,
          title: entry.title,
          thumbnail: entry.thumbnail,
          duration: entry.duration,
          mode: options.mode,
          height: options.height,
          sections: [],
          exact: false,
          merge: false,
          folder,
          openInCut: false,
        };
        validate(single);
        queue.add({ title: entry.title, kind: 'download', run: (job) => runDownload(single, job) });
      });
      return { ok: true, count: options.entries.length, folder };
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  ipcMain.handle('download:history', () => getHistory());
  ipcMain.handle('download:clearHistory', () => {
    store.set('history', []);
    return [];
  });
}

module.exports = { register, buildArgs, normalizeInfo, commonArgs };
