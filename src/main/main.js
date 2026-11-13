// Startpunkt der App: öffnet das Fenster und verbindet Oberfläche und Hintergrund.
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron');

// Die Entwicklungsversion (npm start) läuft getrennt von einer installierten Vitool: eigene Daten,
// eigener Eintrag in der Taskleiste und ein Symbol mit DEV-Schild. Das muss vor allem anderen
// passieren, weil schon beim Laden der Module Einstellungen gelesen werden.
const IS_DEV = !app.isPackaged;
const APP_NAME = IS_DEV ? 'Vitool Dev' : 'Vitool';
const ICON_NAME = IS_DEV ? 'icon-dev' : 'icon';
// Ohne Leerzeichen im Ordnernamen, sonst lädt Windows das Taskleistensymbol aus diesem Ordner nicht.
if (IS_DEV) app.setPath('userData', path.join(app.getPath('appData'), 'Vitool-Dev'));

const { Store } = require('./core/store');
const { JobQueue } = require('./core/job-queue');
const { ToolChecker } = require('./core/tools-check');
const { installTools } = require('./core/tool-installer');
const { YtDlp } = require('./core/ytdlp');
const { createSignIn } = require('./core/sign-in');
const { setupUpdater } = require('./core/updater');
const { CanceledError } = require('./core/process-runner');
const { toGermanMessage } = require('./core/error-messages');
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

const TITLE_BAR_HEIGHT = 34;

// Glas ist Standard. Nur wer es ausdrücklich abschaltet, bekommt das feste Fenster.
function glassOn(value) {
  return value !== false && value !== 'off';
}

// Windows merkt sich Taskleistensymbole nach ihrem Pfad und liest eine geänderte Datei nicht neu ein.
// Deshalb bekommt es eine Kopie, deren Name sich mit dem Inhalt ändert. Ein neues Logo erscheint so sofort.
function taskbarIcon() {
  const source = path.join(__dirname, '..', '..', 'assets', `${ICON_NAME}.ico`);
  try {
    const content = fsSync.readFileSync(source);
    const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 10);
    const folder = path.join(app.getPath('userData'), 'symbole');
    const target = path.join(folder, `icon-${hash}.ico`);
    if (!fsSync.existsSync(target)) {
      fsSync.mkdirSync(folder, { recursive: true });
      // Ältere Kopien werden nicht mehr gebraucht.
      for (const name of fsSync.readdirSync(folder)) fsSync.rmSync(path.join(folder, name), { force: true });
      fsSync.writeFileSync(target, content);
    }
    updatePinnedShortcut(target);
    return target;
  } catch {
    return source;
  }
}

// Beim Anheften legt Windows eine eigene Verknüpfung an und schreibt das damalige Symbol hinein.
// Zeigt sie auf diesen Start von Vitool, bekommt sie das aktuelle Symbol, sonst bliebe das alte angeheftet.
function updatePinnedShortcut(icon) {
  const folder = path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'ImplicitAppShortcuts');
  if (!fsSync.existsSync(folder)) return;
  for (const entry of fsSync.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const link = path.join(folder, entry.name, `${APP_NAME}.lnk`);
    if (!fsSync.existsSync(link)) continue;
    try {
      const shortcut = shell.readShortcutLink(link);
      if (path.resolve(shortcut.target) !== path.resolve(process.execPath) || shortcut.icon === icon) continue;
      shell.writeShortcutLink(link, 'update', { icon, iconIndex: 0 });
    } catch {
      // Eine fremde oder beschädigte Verknüpfung wird nicht angefasst.
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#101216',
    title: APP_NAME,
    icon: path.join(__dirname, '..', '..', 'assets', `${ICON_NAME}.png`),
    autoHideMenuBar: true,
    // Die Titelleiste zeichnet Vitool selbst in der Farbe der Seitenleiste. Windows liefert nur
    // die drei Fensterknöpfe, deren Farben die Oberfläche passend zum Theme setzt.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141416', symbolColor: '#e7e9ed', height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  // Sonst übernimmt das Fenster den Titel der Seite, und die Entwicklungsversion hieße wieder nur Vitool.
  win.on('page-title-updated', (event) => event.preventDefault());
  // Ohne Installer läuft Vitool über electron.exe. Damit Anheften an die Taskleiste trotzdem
  // Vitool mit eigenem Symbol startet, bekommt Windows Startbefehl, Name und Symbol mitgeteilt.
  if (process.platform === 'win32' && !app.isPackaged) {
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: taskbarIcon(),
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: APP_NAME,
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
const APP_ID = IS_DEV ? 'de.vitool.app.dev' : 'de.vitool.app';
app.setAppUserModelId(APP_ID);

app.whenReady().then(() => {
  const store = new Store(path.join(app.getPath('userData'), 'vitool-daten.json'), {
    settings: {
      downloadDir: app.getPath('downloads'),
      openInCut: false,
      ytdlpAutoUpdate: true,
      signInUse: 'needed',
    },
    history: [],
  });
  const queue = new JobQueue();
  const tools = new ToolChecker();
  const signIn = createSignIn({ send, store });
  const ytdlp = new YtDlp({ tools, store, signIn, send });
  ytdlp.startDailyCheck();

  queue.on('change', (jobs) => send('queue:update', jobs));
  setupUpdater({ ipcMain, send, queue });

  ipcMain.on('i18n:get', (event) => {
    // Das Farbschema kommt gleich mit, damit beim Start nichts im falschen Design aufblitzt.
    event.returnValue = { language: currentLanguage(), strings: translations(), languages: LANGUAGES, theme: store.get('settings').theme ?? 'studio', glass: glassOn(store.get('settings').glass) };
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
  // Glas unter Windows 11: "Acrylic" zeigt die Fenster hinter Vitool verschwommen.
  // Windows tönt es hell oder dunkel, passend zum Theme.
  ipcMain.handle('app:setGlass', (_event, on, light = false) => {
    store.set('settings', { ...store.get('settings'), glass: Boolean(on) });
    if (!win || process.platform !== 'win32') return { ok: false };
    nativeTheme.themeSource = on ? (light ? 'light' : 'dark') : 'system';
    win.setBackgroundColor(on ? '#00000000' : '#101216');
    win.setBackgroundMaterial(on ? 'acrylic' : 'none');
    return { ok: true };
  });
  ipcMain.handle('app:setTitleBar', (_event, { color, symbolColor }) => {
    if (!win || process.platform !== 'win32') return { ok: false };
    win.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT });
    return { ok: true };
  });
  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), userData: app.getPath('userData') }));
  // Beide Dateien liegen im Installer, so sind die Lizenzen auch ohne Internet einsehbar.
  ipcMain.handle('app:licenses', async () => {
    const read = (name) => fs.readFile(path.join(app.getAppPath(), name), 'utf8').catch(() => '');
    return { notice: await read('LICENSE-NOTICE.md'), license: await read('LICENSE') };
  });
  ipcMain.handle('tools:check', () => tools.check());
  // Lädt, was fehlt, als Auftrag in der Warteschlange und wartet auf das Ende. Danach wird neu geprüft.
  ipcMain.handle('tools:install', async (_event, missingIds) => {
    try {
      await new Promise((resolve, reject) => {
        queue.add({
          title: t('Programme für Vitool einrichten'),
          kind: 'tools',
          run: (job) => installTools(missingIds, job).then(() => {
            resolve();
            return null;
          }, (error) => {
            reject(error);
            throw error;
          }),
        });
      });
      return { ok: true, ...(await tools.check()) };
    } catch (error) {
      if (error instanceof CanceledError) return { ok: false, canceled: true };
      return { ok: false, error: toGermanMessage(error) };
    }
  });
  ipcMain.handle('tools:updateYtDlp', () => ytdlp.updateNow());
  ipcMain.handle('ytdlp:status', () => ytdlp.getStatus());
  ipcMain.handle('signin:status', () => signIn.status());
  ipcMain.handle('signin:open', (event) => signIn.open(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle('signin:signOut', () => signIn.signOut());
  ipcMain.handle('settings:get', () => store.get('settings'));
  ipcMain.handle('settings:set', (_event, patch) => {
    const settings = { ...store.get('settings'), ...patch };
    store.set('settings', settings);
    if ('ytdlpAutoUpdate' in patch) send('ytdlp:status', ytdlp.getStatus());
    if ('signInUse' in patch) signIn.report();
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

  const context = { ipcMain, queue, store, tools, send, ytdlp };
  features.forEach((feature) => feature.register(context));

  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => features.forEach((feature) => feature.dispose?.()));
