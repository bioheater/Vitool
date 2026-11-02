// Startpunkt der App: öffnet das Fenster und verbindet Oberfläche und Hintergrund.
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const { Store } = require('./core/store');
const { JobQueue } = require('./core/job-queue');
const { ToolChecker } = require('./core/tools-check');
const { listMediaFiles } = require('./core/files');

const VIDEO_FILTERS = [
  { name: 'Videos und Audio', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'mp3', 'm4a', 'wav'] },
  { name: 'Alle Dateien', extensions: ['*'] },
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
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// Damit Windows Vitool in der Taskleiste als eigenes Programm mit eigenem Symbol führt.
app.setAppUserModelId('Vitool');

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

  ipcMain.handle('tools:check', () => tools.check());
  ipcMain.handle('settings:get', () => store.get('settings'));
  ipcMain.handle('settings:set', (_event, patch) => {
    const settings = { ...store.get('settings'), ...patch };
    store.set('settings', settings);
    return settings;
  });
  ipcMain.handle('dialog:pickFolder', async (_event, currentPath) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Zielordner wählen',
      defaultPath: currentPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:pickVideo', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Video auswählen',
      properties: ['openFile'],
      filters: VIDEO_FILTERS,
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:pickVideos', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Videos auswählen',
      properties: ['openFile', 'multiSelections'],
      filters: VIDEO_FILTERS,
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('dialog:pickVideoFolder', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Ordner mit Videos wählen', properties: ['openDirectory'] });
    return result.canceled ? [] : listMediaFiles(result.filePaths[0]);
  });
  ipcMain.handle('dialog:pickTrack', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Spur hinzufügen',
      properties: ['openFile'],
      filters: [
        { name: 'Audio, Untertitel und Video', extensions: ['mp3', 'm4a', 'aac', 'ac3', 'flac', 'mka', 'ogg', 'opus', 'wav', 'srt', 'ass', 'ssa', 'vtt', 'mkv', 'mp4', 'webm'] },
        { name: 'Alle Dateien', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:pickSubtitle', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Untertitel auswählen',
      properties: ['openFile'],
      filters: [
        { name: 'Untertitel', extensions: ['srt', 'ass', 'ssa', 'vtt'] },
        { name: 'Alle Dateien', extensions: ['*'] },
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
