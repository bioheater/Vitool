// Startet yt-dlp und hält es aktuell. Scheitert ein Aufruf, versucht Vitool es noch einmal: mit Anmeldung,
// wenn ein Video sie verlangt, oder mit einer neuen yt-dlp-Version, wenn der Fehler nach einer veralteten aussieht.
const fs = require('fs/promises');
const { run, CanceledError } = require('./process-runner');
const { UserError } = require('./error-messages');
const { binFolder } = require('./tool-installer');
const { t } = require('./i18n');

const DAY_MS = 24 * 3600 * 1000;
// Nach einem Fehler wird höchstens einmal pro Stunde nachgesehen, sonst fragt jeder Fehlversuch GitHub.
const ERROR_CHECK_GAP_MS = 3600 * 1000;
const FIRST_CHECK_DELAY_MS = 20 * 1000;
const TIMER_MS = 3600 * 1000;
const LATEST_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest';

// Fehler, die keine neue Version behebt: Netz, Speicherplatz, gelöschte oder gesperrte Videos.
const FINAL = /unsupported url|is not a valid url|no suitable extractor|drm.protected|is drm|widevine|playready|not available in your country|geo.?restrict|blocked it in your country|video unavailable|video is unavailable|has been removed|does not exist|http error 404|no space left|not enough space|errno 28|permission denied|access is denied|eperm|eacces|ebusy|getaddrinfo|timed out|connection (reset|refused|aborted)|network is unreachable|unable to download webpage|http error 429|too many requests|enoent|premieres in|live event will begin/i;
// Fehler, bei denen eine Anmeldung hilft.
const NEEDS_SIGN_IN = /confirm your age|age.?restricted|inappropriate for some users|private video|this video is private|members.only|join this channel/i;
// YouTube hält den Zugriff für automatisiert. Hier helfen eine Anmeldung oder eine neuere yt-dlp-Version.
const BOT_CHECK = /not a bot|cookies.*authentication|use --cookies/i;

function classify(error) {
  if (error instanceof UserError) return 'final';
  const text = String(error?.message ?? error);
  if (NEEDS_SIGN_IN.test(text)) return 'signin';
  if (BOT_CHECK.test(text)) return 'bot';
  if (FINAL.test(text)) return 'final';
  return 'other';
}

// Versionen wie 2025.10.22 oder 2025.10.22.1, Teil für Teil als Zahl verglichen.
function isNewer(latest, current) {
  const parts = (value) => String(value ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

function urlOf(args) {
  const index = args.lastIndexOf('--');
  return index >= 0 ? args[index + 1] : args.at(-1);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class YtDlp {
  constructor({ tools, store, signIn, send }) {
    this.tools = tools;
    this.store = store;
    this.signIn = signIn;
    this.send = send;
    this.active = 0;
    this.checking = null;
    this.installing = null;
    this.status = { state: 'idle', version: null, error: null, checkedAt: store.get('ytdlpCheckedAt') ?? null };
  }

  autoUpdate() {
    return this.store.get('settings').ytdlpAutoUpdate !== false;
  }

  // Aktualisieren kann Vitool nur seine eigene Kopie, nicht ein über winget installiertes yt-dlp.
  ownCopy() {
    const exe = this.tools.path('ytdlp');
    return Boolean(exe) && exe.toLowerCase().startsWith(binFolder().toLowerCase());
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.send('ytdlp:status', this.getStatus());
  }

  getStatus() {
    return { ...this.status, auto: this.autoUpdate(), ownCopy: this.ownCopy() };
  }

  // Die Weiterleitung von "latest" nennt die neueste Version. Das sind nur ein paar Bytes statt der ganzen Releaseliste.
  async latestVersion() {
    const response = await fetch(LATEST_URL, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const tag = /\/tag\/([^/?#]+)/.exec(response.headers.get('location') ?? '')?.[1];
    if (!tag) throw new Error(`GitHub: ${response.status}`);
    return decodeURIComponent(tag);
  }

  async currentVersion() {
    const { stdout } = await run(this.tools.path('ytdlp'), ['--version']);
    return stdout.trim().split(/\r?\n/)[0];
  }

  // yt-dlp ersetzt sich selbst und prüft dabei die Prüfsumme des Downloads.
  installUpdate() {
    return run(this.tools.path('ytdlp'), ['-U']);
  }

  async whenIdle() {
    while (this.active > 0) await wait(1000);
  }

  // Sieht nach einer neuen Version. Geladen wird sie nur mit install und nur für die eigene Kopie.
  check({ install }) {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      this.setStatus({ state: 'checking', error: null });
      const [current, latest] = await Promise.all([this.currentVersion(), this.latestVersion()]);
      const checkedAt = new Date().toISOString();
      this.store.set('ytdlpCheckedAt', checkedAt);
      if (!isNewer(latest, current)) {
        this.setStatus({ state: 'none', version: current, checkedAt });
        return { state: 'none', version: current };
      }
      if (!install || !this.ownCopy()) {
        this.setStatus({ state: 'available', version: latest, checkedAt });
        return { state: 'available', version: latest };
      }
      // Neue Aufrufe warten, laufende dürfen fertig werden. Dann wird die Datei ersetzt.
      let release;
      this.installing = new Promise((resolve) => { release = resolve; });
      try {
        this.setStatus({ state: 'updating', version: latest, checkedAt });
        await this.whenIdle();
        await this.installUpdate();
        await this.tools.check();
        const version = await this.currentVersion();
        this.setStatus({ state: 'updated', version });
        return { state: 'updated', version };
      } finally {
        this.installing = null;
        release();
      }
    })().catch((error) => {
      this.setStatus({ state: 'error', error: String(error?.message ?? error).split(/\r?\n/).find(Boolean) ?? '' });
      return { state: 'error' };
    }).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  // Einmal am Tag, solange nichts lädt. Ist gerade ein Download aktiv, kommt die nächste Runde später dran.
  startDailyCheck() {
    const tick = () => {
      if (!this.autoUpdate() || !this.ownCopy() || this.active > 0 || this.checking) return;
      const last = Date.parse(this.store.get('ytdlpCheckedAt') ?? '') || 0;
      if (Date.now() - last < DAY_MS) return;
      this.check({ install: true });
    };
    setTimeout(tick, FIRST_CHECK_DELAY_MS);
    setInterval(tick, TIMER_MS);
  }

  async afterError(onStatus) {
    const last = Date.parse(this.store.get('ytdlpCheckedAt') ?? '') || 0;
    if (Date.now() - last < ERROR_CHECK_GAP_MS && this.status.state !== 'available') return { state: 'none' };
    onStatus?.(t('Sieht nach einer neuen yt-dlp-Version …'), false);
    const install = this.autoUpdate();
    const result = await this.check({ install });
    if (result.state === 'updated') onStatus?.(t('yt-dlp ist aktualisiert. Neuer Versuch …'), true);
    return result;
  }

  exec(args, options) {
    return run(this.tools.path('ytdlp'), args, options);
  }

  async once(args, { onLine, signal, cookies }) {
    while (this.installing) await this.installing;
    this.active += 1;
    let cookieFile = null;
    try {
      cookieFile = cookies ? await this.signIn.writeCookieFile() : null;
      const fullArgs = cookieFile ? ['--cookies', cookieFile, ...args] : args;
      return await this.exec(fullArgs, { onLine, signal });
    } finally {
      this.active -= 1;
      if (cookieFile) await fs.rm(cookieFile, { force: true }).catch(() => {});
    }
  }

  // onStatus(text, retrying): kurzer Text für die Warteschlange. retrying heißt, der Aufruf beginnt von vorn.
  async run(args, { onLine, signal, onStatus, signIn = true } = {}) {
    const canSignIn = signIn && this.signIn.isYouTube(urlOf(args));
    const signedIn = canSignIn && await this.signIn.isSignedIn();
    let cookies = signedIn && this.signIn.mode() === 'always';
    let triedCookies = cookies;
    let triedUpdate = false;
    for (;;) {
      try {
        return await this.once(args, { onLine, signal, cookies });
      } catch (error) {
        if (error instanceof CanceledError || signal?.aborted) throw error;
        const kind = classify(error);
        if ((kind === 'signin' || kind === 'bot') && signedIn && !triedCookies) {
          triedCookies = true;
          cookies = true;
          onStatus?.(t('Neuer Versuch mit Anmeldung …'), true);
          continue;
        }
        if ((kind === 'other' || kind === 'bot') && !triedUpdate && this.tools.path('ytdlp')) {
          triedUpdate = true;
          const result = await this.afterError(onStatus);
          if (signal?.aborted) throw new CanceledError();
          if (result.state === 'updated') continue;
          // Ein systemweit installiertes yt-dlp kann Vitool nicht ersetzen, wohl aber eine eigene Kopie laden.
          if (result.state === 'available') error.fix = this.ownCopy() ? 'update' : 'ownCopy';
        }
        if (!error.fix && (kind === 'signin' || kind === 'bot') && canSignIn && !signedIn) error.fix = 'signin';
        throw error;
      }
    }
  }

  // Der Knopf in den Einstellungen und in Fehlermeldungen.
  async updateNow() {
    const result = await this.check({ install: true });
    if (result.state === 'updated') return { ok: true, message: t('yt-dlp ist jetzt auf Version {version}.', { version: result.version }) };
    if (result.state === 'none') return { ok: true, message: t('yt-dlp ist auf dem neuesten Stand.') };
    if (result.state === 'available') return { ok: false, error: t('Vitool kann nur seine eigene Kopie von yt-dlp aktualisieren.') };
    return { ok: false, error: t('Das Update von yt-dlp hat nicht geklappt. Prüfe bitte deine Internetverbindung.') };
  }
}

module.exports = { YtDlp, classify, isNewer };
