// Updates für Vitool selbst aus den GitHub-Releases. Gesucht wird beim Start still und auf Knopfdruck,
// geladen und installiert wird nur auf Wunsch. Ein geladenes Update wird spätestens beim Beenden installiert.
const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { t } = require('./i18n');

const RELEASES_URL = 'https://github.com/bioheater/Vitool/releases';
const STARTUP_DELAY_MS = 10000;

// Zum Ausprobieren ohne installierte Fassung: VITOOL_UPDATE_TEST setzen und dev-app-update.yml anlegen.
const testMode = !app.isPackaged && Boolean(process.env.VITOOL_UPDATE_TEST);

function friendlyError(error) {
  const text = String(error?.message ?? error);
  // Ohne veröffentlichtes Release oder bei privatem Repository antwortet GitHub mit 404.
  if (/404|Unable to find latest version|No published versions/i.test(text)) return t('Es gibt noch keine veröffentlichte Version zum Aktualisieren.');
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::ERR/i.test(text)) return t('Keine Verbindung zu GitHub. Prüfe die Internetverbindung.');
  if (/sha512|checksum/i.test(text)) return t('Die heruntergeladene Datei ist beschädigt. Bitte versuche es noch einmal.');
  return t('Die Suche nach Updates hat nicht geklappt.');
}

function setupUpdater({ ipcMain, send, queue }) {
  let status = { state: app.isPackaged || testMode ? 'idle' : 'dev', current: app.getVersion() };
  const setStatus = (patch) => {
    status = { ...status, ...patch };
    send('update:status', status);
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  if (testMode) autoUpdater.forceDevUpdateConfig = true;

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => setStatus({ state: 'available', version: info.version, progress: 0 }));
  autoUpdater.on('update-not-available', () => setStatus({ state: 'none' }));
  autoUpdater.on('download-progress', (progress) => setStatus({ state: 'downloading', progress: progress.percent }));
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'ready', version: info.version, progress: 100 }));
  autoUpdater.on('error', (error) => setStatus({ state: 'error', error: friendlyError(error) }));

  // Fehler kommen zusätzlich über das Ereignis oben, hier wird nur verhindert, dass sie unbehandelt bleiben.
  const check = () => autoUpdater.checkForUpdates().catch(() => {});

  ipcMain.handle('update:status', () => status);
  ipcMain.handle('update:check', async () => {
    if (status.state === 'dev') return status;
    await check();
    return status;
  });
  ipcMain.handle('update:download', async () => {
    if (status.state !== 'available') return status;
    setStatus({ state: 'downloading', progress: 0 });
    await autoUpdater.downloadUpdate().catch(() => {});
    return status;
  });
  // Laufende Aufträge würden beim Neustart abbrechen. Die Oberfläche fragt deshalb vorher nach.
  ipcMain.handle('update:install', (_event, force) => {
    if (status.state !== 'ready') return { ok: false };
    const busy = queue.list().some((job) => job.status === 'running' || job.status === 'queued');
    if (busy && !force) return { ok: false, busy: true };
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });
  ipcMain.handle('update:openReleases', () => shell.openExternal(status.version ? `${RELEASES_URL}/tag/v${status.version}` : RELEASES_URL));

  // Beim Start still nachsehen. Fehler, etwa ohne Internet, fallen dabei nicht auf.
  if (app.isPackaged || testMode) {
    setTimeout(() => {
      check().then(() => {
        if (status.state === 'error') setStatus({ state: 'idle', error: null });
      });
    }, STARTUP_DELAY_MS);
  }
}

module.exports = { setupUpdater };
