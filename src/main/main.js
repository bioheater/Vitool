// Startpunkt der App: öffnet das Fenster und verbindet Oberfläche und Hintergrund.
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const { Store } = require('./core/store');
const { JobQueue } = require('./core/job-queue');
const { ToolChecker } = require('./core/tools-check');
const { listMediaFiles } = require('./core/files');
const { t, currentLanguage, translations, LANGUAGES } = require('./core/i18n');

const VIDEO_FILTERS = [
  { name: t('Videos und Audio'), extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'] },
  { name: t('Alle Dateien'), extensions: ['*'] },
];

// Neue Bereiche: Modul anlegen und hier eintragen.
const features = [
  require('./features/media'),
  require('./features/download'),
  require('./features/cut'),
  require('./features/convert'),
  require('./features/tools'),
  require('./features/mkv'),
  require('./features/censor'),
  require('./features/ai'),
  require('./features/transcribe'),
];

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#101216',
    title: 'Vitool',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  // Ohne Installer läuft Vitool über electron.exe. Damit Anheften an die Taskleiste trotzdem
  // Vitool mit eigenem Symbol startet, bekommt Windows Startbefehl, Name und Symbol mitgeteilt.
  if (process.platform === 'win32' && !app.isPackaged) {
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'Vitool',
    });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// Damit Windows Vitool in der Taskleiste als eigenes Programm mit eigenem Symbol führt.
// Muss zur appId des Installers passen, sonst gehören Verknüpfung und Fenster nicht zusammen.
const APP_ID = 'de.vitool.app';
app.setAppUserModelId(APP_ID);

app.whenReady().then(() => {
  const store = new Store(path.join(app.getPath('userData'), 'vitool-daten.json'), {
    settings: {
      downloadDir: app.getPath('downloads'),
      openInCut: false,
    },
    history: [],
  });
  const queue = new JobQueue();
  const tools = new ToolChecker();

  queue.on('change', (jobs) => send('queue:update', jobs));

  ipcMain.on('i18n:get', (event) => {
    // Das Farbschema kommt gleich mit, damit beim Start nichts im falschen Design aufblitzt.
    event.returnValue = { language: currentLanguage(), strings: translations(), languages: LANGUAGES, theme: store.get('settings').theme ?? 'aurora' };
  });
  // Ein Sprachwechsel startet Vitool neu, damit wirklich jeder Text in der neuen Sprache erscheint.
  ipcMain.handle('app:setLanguage', (_event, language) => {
    if (!LANGUAGES.some((entry) => entry.id === language)) return { ok: false };
    store.set('settings', { ...store.get('settings'), language });
    if (queue.list().some((job) => job.status === 'running' || job.status === 'queued')) return { ok: true, restartLater: true };
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), userData: app.getPath('userData') }));
  ipcMain.handle('tools:check', () => tools.check());
  ipcMain.handle('settings:get', () => store.get('settings'));
  ipcMain.handle('settings:set', (_event, patch) => {
    const settings = { ...store.get('settings'), ...patch };
    store.set('settings', settings);
    return settings;
  });
  ipcMain.handle('dialog:pickFolder', async (_event, currentPath) => {
    const result = await dialog.showOpenDialog(win, {
      title: t('Zielordner wählen'),
      defaultPath: currentPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:pickVideo', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: t('Video auswählen'),
      properties: ['openFile'],
      filters: VIDEO_FILTERS,
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:pickVideos', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: t('Videos auswählen'),
      properties: ['openFile', 'multiSelections'],
      filters: VIDEO_FILTERS,
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('dialog:pickVideoFolder', async () => {
    const result = await dialog.showOpenDialog(win, { title: t('Ordner mit Videos wählen'), properties: ['openDirectory'] });
    return result.canceled ? [] : listMediaFiles(result.filePaths[0]);
  });
  ipcMain.handle('dialog:pickTrack', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: t('Spur hinzufügen'),
      properties: ['openFile'],
      filters: [
        { name: t('Audio, Untertitel und Video'), extensions: ['mp3', 'm4a', 'aac', 'ac3', 'flac', 'mka', 'ogg', 'opus', 'wav', 'srt', 'ass', 'ssa', 'vtt', 'mkv', 'mp4', 'webm'] },
        { name: t('Alle Dateien'), extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:pickSubtitle', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: t('Untertitel auswählen'),
      properties: ['openFile'],
      filters: [
        { name: t('Untertitel'), extensions: ['srt', 'ass', 'ssa', 'vtt'] },
        { name: t('Alle Dateien'), extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('shell:openFile', (_event, filePath) => shell.openPath(filePath));
  ipcMain.handle('shell:showFile', (_event, filePath) => shell.showItemInFolder(filePath));
  ipcMain.handle('queue:list', () => queue.list());
  ipcMain.handle('queue:cancel', (_event, id) => queue.cancel(id));
  ipcMain.handle('queue:clearFinished', () => queue.clearFinished());

  const context = { ipcMain, queue, store, tools, send };
  features.forEach((feature) => feature.register(context));

  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => features.forEach((feature) => feature.dispose?.()));
