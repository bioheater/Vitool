// Freiwillige Anmeldung bei YouTube. Sie läuft in einem eigenen Fenster mit eigenem Speicher, getrennt vom
// Browser. Vitool reicht die Cookies nur beim Aufruf von yt-dlp weiter, als Datei, die gleich wieder gelöscht wird.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { BrowserWindow, session } = require('electron');
const { t } = require('./i18n');

const PARTITION = 'persist:vitool-anmeldung';
const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F';
const LOGIN_COOKIES = ['LOGIN_INFO', 'SID', '__Secure-3PSID'];
const FIREFOX_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

function isYouTube(url) {
  try {
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Vitool und Electron stehen sonst in der Browserkennung, und manche Seiten liefern dann nichts aus.
function plainUserAgent(agent) {
  return agent.split(' ').filter((part) => !/^(electron|vitool)\//i.test(part)).join(' ');
}

// Das Format, das yt-dlp mit --cookies liest (Netscape cookies.txt).
function cookieLine(cookie) {
  const domain = !cookie.hostOnly && !cookie.domain.startsWith('.') ? `.${cookie.domain}` : cookie.domain;
  return [
    `${cookie.httpOnly ? '#HttpOnly_' : ''}${domain}`,
    cookie.hostOnly ? 'FALSE' : 'TRUE',
    cookie.path || '/',
    cookie.secure ? 'TRUE' : 'FALSE',
    String(Math.round(cookie.expirationDate ?? 0)),
    cookie.name,
    cookie.value,
  ].join('\t');
}

function createSignIn({ send, store }) {
  const signInSession = session.fromPartition(PARTITION);
  let win = null;
  let rejected = false;

  // Google lehnt die Anmeldung in eingebetteten Chromium-Fenstern ab ("Dieser Browser ist unter Umständen
  // nicht sicher"). Als Firefox ausgegeben klappt sie. Dazu passen die Kennung, die fehlenden Chromium-Angaben
  // in den Anfragen (Client Hints) und im Fenster selbst (siehe sign-in-preload.js).
  signInSession.setUserAgent(FIREFOX_AGENT);
  signInSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).filter(([name]) => !/^sec-ch-ua/i.test(name)));
    callback({ requestHeaders: headers });
  });
  signInSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  signInSession.on('will-download', (event) => event.preventDefault());

  async function youtubeCookies() {
    const cookies = await signInSession.cookies.get({});
    return cookies.filter((cookie) => /(^|\.)youtube\.com$/i.test(cookie.domain.replace(/^\./, '')));
  }

  async function isSignedIn() {
    return (await youtubeCookies()).some((cookie) => LOGIN_COOKIES.includes(cookie.name));
  }

  function mode() {
    return store.get('settings').signInUse === 'always' ? 'always' : 'needed';
  }

  async function status() {
    return { signedIn: await isSignedIn(), open: Boolean(win), rejected, mode: mode() };
  }

  async function report() {
    send('signin:status', await status());
  }

  // Google wechselt die Seiten oft ohne echten Seitenaufruf, deshalb zählen beide Arten von Navigation.
  async function onNavigate(url) {
    if (/accounts\.google\.com\/.*signin\/rejected/i.test(url)) {
      rejected = true;
      report();
      return;
    }
    // Ist die Anmeldung geschafft, landet Google wieder auf YouTube. Dann wird das Fenster nicht mehr gebraucht.
    if (isYouTube(url) && await isSignedIn()) {
      rejected = false;
      report();
      setTimeout(() => win?.close(), 800);
    }
  }

  function open(owner) {
    if (win) {
      win.focus();
      return;
    }
    rejected = false;
    win = new BrowserWindow({
      width: 520,
      height: 720,
      title: t('Vitool: Bei YouTube anmelden'),
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        preload: path.join(__dirname, '..', 'sign-in-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.on('page-title-updated', (event) => event.preventDefault());
    // Neue Fenster öffnen sich nicht, die Anmeldung bleibt in diesem einen.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:/i.test(url)) win.loadURL(url);
      return { action: 'deny' };
    });
    win.webContents.on('did-navigate', (_event, url) => onNavigate(url));
    win.webContents.on('did-navigate-in-page', (_event, url) => onNavigate(url));
    win.on('closed', () => {
      win = null;
      report();
    });
    owner?.once('closed', () => win?.close());
    win.loadURL(LOGIN_URL);
    report();
  }

  // Meldet das Konto bei Google ab, damit die gespeicherte Anmeldung auch dort ungültig wird, und löscht sie dann.
  async function signOut() {
    win?.close();
    const helper = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, sandbox: true } });
    try {
      await Promise.race([
        helper.loadURL('https://www.youtube.com/logout').catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    } finally {
      helper.destroy();
    }
    await signInSession.clearStorageData();
    await signInSession.clearCache();
    await report();
  }

  // Schreibt die YouTube-Cookies in eine kurzlebige Datei. Der Aufrufer löscht sie nach dem Lauf.
  async function writeCookieFile() {
    const cookies = await youtubeCookies();
    if (!cookies.length) return null;
    const file = path.join(os.tmpdir(), `vitool-anmeldung-${randomUUID()}.txt`);
    const lines = ['# Netscape HTTP Cookie File', ...cookies.map(cookieLine), ''];
    await fs.writeFile(file, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
    return file;
  }

  return { open, signOut, status, report, isSignedIn, mode, writeCookieFile, isYouTube };
}

module.exports = { createSignIn, cookieLine, isYouTube, plainUserAgent };
