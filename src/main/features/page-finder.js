// Sucht Videos auf Seiten, die yt-dlp nicht kennt. Die Seite läuft in einem eigenen Fenster,
// und Vitool merkt sich die Videoadressen, die der Player beim Abspielen lädt.
const { BrowserWindow, session } = require('electron');
const { t } = require('../core/i18n');

// Ohne "persist:" bleiben Anmeldungen und Cookies nur bis zum Beenden im Speicher.
const PARTITION = 'vitool-page-finder';
const CONTENT_TYPES = {
  'application/vnd.apple.mpegurl': 'hls',
  'application/x-mpegurl': 'hls',
  'audio/mpegurl': 'hls',
  'audio/x-mpegurl': 'hls',
  'application/dash+xml': 'dash',
  'video/mp4': 'file',
  'video/webm': 'file',
  'video/quicktime': 'file',
};
const KIND_ORDER = { hls: 0, dash: 1, file: 2 };
const FORWARDED_HEADERS = ['Referer', 'Origin'];

function headerValue(headers, name) {
  const key = Object.keys(headers ?? {}).find((entry) => entry.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function pathOf(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

// Playlisten von Streams erkennt man an Endung oder Inhaltstyp. Direkte Videodateien zählen nur,
// wenn sie als Ganzes abgespielt werden, sonst landen die Einzelstücke eines Streams in der Liste.
function classify({ url, resourceType, responseHeaders }) {
  if (!/^https?:/i.test(url)) return null;
  const file = pathOf(url);
  if (file.endsWith('.m3u8')) return 'hls';
  if (file.endsWith('.mpd')) return 'dash';
  const type = String(headerValue(responseHeaders, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
  const kind = CONTENT_TYPES[type];
  if (kind === 'hls' || kind === 'dash') return kind;
  if (/\.(m4s|ts|m4a|aac)$/.test(file)) return null;
  const videoFile = kind === 'file' || /\.(mp4|webm|mov)$/.test(file);
  return videoFile && resourceType === 'media' ? 'file' : null;
}

function describe(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
    return { host: hostname, name: name.length > 60 ? `${name.slice(0, 57)}…` : name };
  } catch {
    return { host: '', name: url.slice(0, 60) };
  }
}

// Vitool und Electron stehen sonst in der Browserkennung, und manche Seiten liefern dann nichts aus.
function plainUserAgent(agent) {
  return agent.split(' ').filter((part) => !/^(electron|vitool)\//i.test(part)).join(' ');
}

function createPageFinder({ send }) {
  const pageSession = session.fromPartition(PARTITION);
  const userAgent = plainUserAgent(pageSession.getUserAgent());
  const requestHeaders = new Map();
  let win = null;
  let found = [];
  let pageUrl = null;

  pageSession.setUserAgent(userAgent);
  pageSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  pageSession.on('will-download', (event) => event.preventDefault());

  const report = () => send('download:pageMedia', {
    open: Boolean(win),
    title: win ? win.webContents.getTitle() : '',
    items: [...found]
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id - b.id)
      .map(({ id, kind, host, name }) => ({ id, kind, host, name })),
  });

  pageSession.webRequest.onSendHeaders(({ id, requestHeaders: headers }) => {
    requestHeaders.set(id, headers);
  });
  pageSession.webRequest.onErrorOccurred(({ id }) => requestHeaders.delete(id));
  pageSession.webRequest.onResponseStarted((details) => {
    const headers = requestHeaders.get(details.id) ?? {};
    requestHeaders.delete(details.id);
    if (!win || details.statusCode >= 400) return;
    const kind = classify(details);
    if (!kind || found.some((item) => item.url === details.url)) return;
    found.push({ id: found.length + 1, url: details.url, kind, headers, ...describe(details.url) });
    report();
  });

  function open(url, owner) {
    found = [];
    pageUrl = url;
    if (win) {
      win.loadURL(url);
      win.focus();
      report();
      return;
    }
    win = new BrowserWindow({
      width: 1100,
      height: 760,
      title: t('Vitool: Video auf der Seite suchen'),
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    // Der feste Titel zeigt, dass dieses Fenster zu Vitool gehört und kein normaler Browser ist.
    win.on('page-title-updated', (event) => {
      event.preventDefault();
      report();
    });
    // Werbung öffnet gern neue Fenster. Die Seite bleibt in diesem einen Fenster.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      win = null;
      report();
    });
    // Schließt jemand Vitool, darf das Suchfenster das Programm nicht im Hintergrund weiterlaufen lassen.
    owner?.once('closed', close);
    win.loadURL(url);
    report();
  }

  // Liefert Adresse und Herkunftsangaben, mit denen yt-dlp den Stream genauso abruft wie der Player.
  async function take(id) {
    const item = found.find((entry) => entry.id === id);
    if (!item) return null;
    const headers = { 'User-Agent': userAgent };
    FORWARDED_HEADERS.forEach((name) => {
      const value = headerValue(item.headers, name);
      if (value) headers[name] = value;
    });
    if (!headers.Referer && pageUrl) headers.Referer = pageUrl;
    const cookies = await pageSession.cookies.get({ url: item.url });
    if (cookies.length) headers.Cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    const title = win ? win.webContents.getTitle() : '';
    return { url: item.url, headers, title, pageUrl };
  }

  function close() {
    win?.close();
  }

  return { open, take, close };
}

module.exports = { createPageFinder, classify, plainUserAgent };
