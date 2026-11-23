// Sucht Videos auf Seiten, die yt-dlp nicht kennt. Vitool öffnet die Seite und merkt sich die Videoadressen,
// die der Player beim Abspielen lädt. Das geht sichtbar, dann startet man das Video selbst, oder unsichtbar:
// Dann startet Vitool es stumm und schließt die Seite wieder, sobald der Stream gefunden ist.
const fs = require('fs/promises');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { CanceledError } = require('../core/process-runner');
const { t } = require('../core/i18n');
const { plainUserAgent } = require('../core/sign-in');

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
const SUBTITLE_TYPES = ['text/vtt', 'application/x-subrip', 'text/srt'];
const KIND_ORDER = { hls: 0, dash: 1, file: 2 };
const FORWARDED_HEADERS = ['Referer', 'Origin'];
const ADS = /doubleclick|googlesyndication|imasdk|adservice|\/ads?\//i;

// Die unsichtbare Suche gibt einer Seite insgesamt so lange Zeit, ein Video zu laden.
const PROBE_LIMIT_MS = 25000;
// Ohne Player auf der Seite, etwa bei einer Übersicht, endet die Suche schon nach dieser Zeit.
const NO_PLAYER_MS = 5000;
// Nach dem ersten Fund kommen oft noch Untertitel oder weitere Qualitätsstufen nach.
const SETTLE_MS = 2500;
const POLL_MS = 1000;
const MIN_GROUP = 3;
// Kleinere Videodateien sind Platzhalter: leere Clips zum Testen von Autoplay oder anstelle blockierter Werbung.
const SMALL_FILE_BYTES = 1024 * 1024;
// So oft drückt die Suche höchstens auf einen Play-Knopf, etwa noch einmal nach so einem Platzhalter.
const MAX_PRESSES = 3;

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

function contentType(headers) {
  return String(headerValue(headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
}

// Playlisten von Streams erkennt man an Endung oder Inhaltstyp. Direkte Videodateien zählen nur,
// wenn sie als Ganzes abgespielt werden, sonst landen die Einzelstücke eines Streams in der Liste.
function classify({ url, resourceType, responseHeaders }) {
  if (!/^https?:/i.test(url)) return null;
  const file = pathOf(url);
  if (file.endsWith('.m3u8')) return 'hls';
  if (file.endsWith('.mpd')) return 'dash';
  const kind = CONTENT_TYPES[contentType(responseHeaders)];
  if (kind === 'hls' || kind === 'dash') return kind;
  if (/\.(m4s|ts|m4a|aac)$/.test(file)) return null;
  const videoFile = kind === 'file' || /\.(mp4|webm|mov)$/.test(file);
  return videoFile && resourceType === 'media' ? 'file' : null;
}

// Gesamtgröße einer Datei. Bei Teilabrufen steht sie hinter dem Schrägstrich in Content-Range.
function fileSize(headers) {
  const range = /\/(\d+)\s*$/.exec(String(headerValue(headers, 'content-range') ?? ''));
  const size = Number(range?.[1] ?? headerValue(headers, 'content-length'));
  return Number.isFinite(size) && size > 0 ? size : null;
}

function isPlaceholder(item) {
  return ADS.test(item.url) || (item.kind === 'file' && item.size !== null && item.size < SMALL_FILE_BYTES);
}

function isSubtitle({ url, responseHeaders }) {
  if (!/^https?:/i.test(url)) return false;
  return /\.(vtt|srt)$/.test(pathOf(url)) || SUBTITLE_TYPES.includes(contentType(responseHeaders));
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

// "Folge 3 · Sendung · Archiv" wird zu "Folge 3". Der Name der Seite steht meist hinten.
function cleanTitle(title) {
  const text = String(title ?? '').trim();
  const first = text.split(/\s+[·|]\s+/)[0].trim();
  return first.length >= 3 ? first : text;
}

// Der eigentliche Film ist meist ein Stream. Werbung und Platzhalter kommen oft zuerst, deshalb fallen sie weg.
function pickBest(found) {
  const usable = found.filter((item) => !isPlaceholder(item));
  return [...(usable.length ? usable : found)].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id - b.id)[0] ?? null;
}

// Startet in jedem Rahmen der Seite die Videos stumm. Läuft keins, drückt es auf einen Play-Knopf, sichtbare zuerst.
// Zu Ende gespielte Videos bleiben stehen: Oft war das nur ein Platzhalter und danach wartet der Player auf einen Klick.
const START_PLAYER = `(() => {
  const media = [...document.querySelectorAll('video, audio')];
  media.forEach((element) => {
    element.muted = true;
    if (element.paused && !element.ended) element.play().catch(() => {});
  });
  const buttons = [...document.querySelectorAll('.vjs-big-play-button, .plyr__control--overlaid, .mejs__overlay-button, .jw-display-icon-container, .ytp-large-play-button, [class*="play-button" i], [class*="playbutton" i], [class*="play-btn" i], button[aria-label*="play" i], [title="Play" i]')];
  const shown = buttons.filter((button) => button.getClientRects().length > 0);
  const presses = window.__vitoolPresses || 0;
  if (presses < ${MAX_PRESSES} && buttons.length && media.every((element) => element.paused || element.ended)) {
    window.__vitoolPresses = presses + 1;
    (shown[0] || buttons[0]).click();
  }
  return media.length + buttons.length;
})()`;

// Alle Links der Seite mit lesbarem Namen. Hat ein Link nur ein Bild, steht der Name oft gleich daneben.
// Links in Kopfzeile, Menü und Fußzeile werden markiert, dort stehen selten die gesuchten Videos.
const READ_LINKS = `(() => {
  const NAVIGATION = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';
  const isFileName = (text) => /\\.(png|jpe?g|gif|webp|svg)$/i.test(text.trim());
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('a[href]')].map((link) => {
    let text = clean(link.innerText);
    let box = link;
    for (let level = 0; !text && level < 3 && box.parentElement; level += 1) {
      const parent = box.parentElement;
      const targets = new Set([...parent.querySelectorAll('a[href]')].map((other) => other.href));
      if (targets.size > 1) break;
      box = parent;
      text = clean(box.innerText);
    }
    if (!text) {
      const alt = clean(link.querySelector('img')?.alt || link.title);
      if (alt && !isFileName(alt)) text = alt;
    }
    const image = link.querySelector('img') || box.querySelector('img');
    return { href: link.href, text: text.slice(0, 200), thumbnail: image?.currentSrc || image?.src || null, menu: Boolean(link.closest(NAVIGATION)) };
  });
})()`;

// Sucht unter den Links einer Seite die größte Gruppe mit gleichem Aufbau, etwa ".../item/2387", ".../item/2388".
// Links aus Menüs zählen nur, wenn die Seite sonst kaum Links hat.
function groupLinks(links, pageUrl) {
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  page.hash = '';
  const groups = new Map();
  const content = links.filter((link) => !link.menu);
  (content.length >= MIN_GROUP ? content : links).forEach(({ href, text, thumbnail }, position) => {
    let url;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    url.hash = '';
    if (!/^https?:$/.test(url.protocol) || url.href === page.href) return;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0 || /\.(jpe?g|png|gif|webp|svg|pdf|css|js|zip)$/i.test(url.pathname)) return;
    const key = `${url.host}/${parts.slice(0, -1).join('/')}/*${url.search ? '?' : ''}`;
    const group = groups.get(key) ?? { first: position, entries: new Map() };
    groups.set(key, group);
    const entry = group.entries.get(url.href);
    if (!entry) group.entries.set(url.href, { url: url.href, title: text || '', thumbnail });
    else {
      if (!entry.title && text) entry.title = text;
      if (!entry.thumbnail && thumbnail) entry.thumbnail = thumbnail;
    }
  });
  const best = [...groups.values()]
    .filter((group) => group.entries.size >= MIN_GROUP)
    .sort((a, b) => b.entries.size - a.entries.size || a.first - b.first)[0];
  return best ? [...best.entries.values()] : [];
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Werbebanner legen sich gern über den Player und lassen sich oft nicht wegklicken. Ein Werbefilter
// (EasyList und Co. über Ghostery) blockiert Werbeserver und blendet Banner auf der Seite aus. Nur
// Werbung, keine Tracker: Manche Player laufen ohne ihre Statistik-Skripte nicht mehr.
// Die Listen kommen beim ersten Öffnen einer Seite und werden eine Woche lang wiederverwendet.
const FILTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Ohne Netz oder bei einem Fehler wartet die Seite nicht länger als hier und lädt dann ohne Filter.
const FILTER_WAIT_MS = 8000;

async function loadBlocker() {
  const cacheFile = path.join(app.getPath('userData'), 'werbefilter.bin');
  try {
    const { mtimeMs } = await fs.stat(cacheFile);
    if (Date.now() - mtimeMs > FILTER_MAX_AGE_MS) await fs.rm(cacheFile, { force: true });
  } catch {
    // Noch keine Listen gespeichert.
  }
  return ElectronBlocker.fromPrebuiltAdsOnly(fetch, {
    path: cacheFile,
    read: fs.readFile,
    write: fs.writeFile,
  });
}

function createPageFinder({ send }) {
  const pageSession = session.fromPartition(PARTITION);
  const userAgent = plainUserAgent(pageSession.getUserAgent());
  const requestHeaders = new Map();
  // Jede offene Seite sammelt ihre Funde für sich, damit sich zwei Suchen nicht vermischen.
  const pages = new Map();
  let win = null;
  let visible = null;

  pageSession.setUserAgent(userAgent);
  pageSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  pageSession.on('will-download', (event) => event.preventDefault());

  // Startet den Werbefilter einmal für alle Seiten. Klappt es nicht, etwa ohne Netz, versucht es die nächste Seite erneut.
  let blocking = null;
  function adBlockReady() {
    blocking ??= loadBlocker().then((blocker) => {
      blocker.enableBlockingInSession(pageSession);
      return true;
    }).catch(() => {
      blocking = null;
      return false;
    });
    return Promise.race([blocking, wait(FILTER_WAIT_MS).then(() => false)]);
  }

  // Lädt die Seite erst, wenn der Werbefilter bereit ist, sonst rutscht die Werbung beim ersten Mal durch.
  function load(target, url) {
    adBlockReady().then(() => {
      if (!target.isDestroyed()) target.loadURL(url).catch(() => {});
    });
  }

  const report = () => send('download:pageMedia', {
    open: Boolean(win),
    title: win ? win.webContents.getTitle() : '',
    items: [...(visible?.found ?? [])]
      .sort((a, b) => isPlaceholder(a) - isPlaceholder(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id - b.id)
      .map(({ id, kind, host, name }) => ({ id, kind, host, name })),
  });

  pageSession.webRequest.onSendHeaders(({ id, requestHeaders: headers }) => {
    requestHeaders.set(id, headers);
  });
  pageSession.webRequest.onErrorOccurred(({ id }) => requestHeaders.delete(id));
  pageSession.webRequest.onResponseStarted((details) => {
    const headers = requestHeaders.get(details.id) ?? {};
    requestHeaders.delete(details.id);
    const page = pages.get(details.webContentsId);
    if (!page || details.statusCode >= 400) return;
    if (isSubtitle(details)) {
      if (!page.subtitles.some((item) => item.url === details.url)) page.subtitles.push({ url: details.url, headers });
      return;
    }
    const kind = classify(details);
    if (!kind || page.found.some((item) => item.url === details.url)) return;
    page.found.push({
      id: page.found.length + 1, url: details.url, kind, headers, size: fileSize(details.responseHeaders), ...describe(details.url),
    });
    page.onChange?.();
  });

  // Adresse und Herkunftsangaben, mit denen yt-dlp den Stream genauso abruft wie der Player.
  async function sourceFor(item, page, title) {
    const headersFor = (entry) => {
      const headers = { 'User-Agent': userAgent };
      FORWARDED_HEADERS.forEach((name) => {
        const value = headerValue(entry.headers, name);
        if (value) headers[name] = value;
      });
      if (!headers.Referer && page.url) headers.Referer = page.url;
      return headers;
    };
    const withCookies = async (entry) => {
      const headers = headersFor(entry);
      const cookies = await pageSession.cookies.get({ url: entry.url });
      if (cookies.length) headers.Cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
      return headers;
    };
    const subtitles = [];
    for (const entry of page.subtitles) subtitles.push({ url: entry.url, headers: await withCookies(entry) });
    return { url: item.url, headers: await withCookies(item), title: cleanTitle(title), pageUrl: page.url, subtitles };
  }

  function open(url, owner) {
    visible = { url, found: [], subtitles: [], onChange: report };
    if (win) {
      pages.set(win.webContents.id, visible);
      load(win, url);
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
    const id = win.webContents.id;
    pages.set(id, visible);
    win.setMenuBarVisibility(false);
    // Der feste Titel zeigt, dass dieses Fenster zu Vitool gehört und kein normaler Browser ist.
    win.on('page-title-updated', (event) => {
      event.preventDefault();
      report();
    });
    // Werbung öffnet gern neue Fenster. Die Seite bleibt in diesem einen Fenster.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      pages.delete(id);
      win = null;
      report();
    });
    // Schließt jemand Vitool, darf das Suchfenster das Programm nicht im Hintergrund weiterlaufen lassen.
    owner?.once('closed', close);
    load(win, url);
    report();
  }

  async function take(id) {
    const item = visible?.found.find((entry) => entry.id === id);
    if (!item) return null;
    return sourceFor(item, visible, win ? win.webContents.getTitle() : '');
  }

  function close() {
    win?.close();
  }

  async function inAllFrames(contents, code) {
    const frames = contents.mainFrame?.framesInSubtree ?? [];
    const results = await Promise.all(frames.map((frame) => frame.executeJavaScript(code).catch(() => 0)));
    return results.reduce((sum, value) => sum + (Number(value) || 0), 0);
  }

  // Öffnet die Seite unsichtbar und ohne Ton, startet das Video und wartet auf den Stream.
  // Mit links liefert sie zusätzlich die Links der Seite, falls dort statt eines Videos eine Übersicht ist.
  async function probe(url, { signal, links = false } = {}) {
    if (signal?.aborted) throw new CanceledError();
    const hidden = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    const contents = hidden.webContents;
    const page = { url, found: [], subtitles: [] };
    pages.set(contents.id, page);
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const abort = () => hidden.destroy();
    signal?.addEventListener('abort', abort);

    let loadedAt = null;
    contents.on('did-finish-load', () => {
      loadedAt ??= Date.now();
    });
    try {
      await adBlockReady();
      if (hidden.isDestroyed()) throw new CanceledError();
      contents.loadURL(url).catch(() => {});
      const started = Date.now();
      let foundAt = null;
      let players = 0;
      while (!hidden.isDestroyed()) {
        await wait(POLL_MS);
        if (signal?.aborted || hidden.isDestroyed()) throw new CanceledError();
        const now = Date.now();
        // Nur Platzhalter gefunden: weitersuchen und den Player noch einmal anstoßen.
        if (page.found.some((item) => !isPlaceholder(item))) {
          foundAt ??= now;
          if (now - foundAt >= SETTLE_MS) break;
          continue;
        }
        if (now - started > PROBE_LIMIT_MS) break;
        if (!loadedAt) continue;
        players = Math.max(players, await inAllFrames(contents, START_PLAYER));
        if (!players && now - loadedAt > NO_PLAYER_MS) break;
      }
      if (hidden.isDestroyed()) throw new CanceledError();
      const title = contents.getTitle();
      const best = pickBest(page.found);
      const source = best ? await sourceFor(best, page, title) : null;
      const pageLinks = links ? groupLinks(await contents.executeJavaScript(READ_LINKS).catch(() => []), contents.getURL() || url) : [];
      return { source, links: pageLinks, title: cleanTitle(title) };
    } finally {
      signal?.removeEventListener('abort', abort);
      pages.delete(contents.id);
      if (!hidden.isDestroyed()) hidden.destroy();
    }
  }

  return { open, take, close, probe };
}

module.exports = { createPageFinder, classify, groupLinks, cleanTitle, plainUserAgent };
