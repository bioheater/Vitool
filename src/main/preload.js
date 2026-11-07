// Kontrollierte Brücke: Die Oberfläche darf nur diese Kanäle benutzen.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE_CHANNELS = [
  'tools:check',
  'tools:install',
  'tools:updateYtDlp',
  'update:status',
  'update:check',
  'update:download',
  'update:install',
  'update:openReleases',
  'settings:get',
  'settings:set',
  'dialog:pickFolder',
  'shell:openFile',
  'shell:showFile',
  'queue:list',
  'queue:cancel',
  'queue:clearFinished',
  'download:info',
  'download:start',
  'download:history',
  'download:playlist',
  'download:playlistStart',
  'download:clearHistory',
  'dialog:pickVideo',
  'media:probe',
  'media:preparePreview',
  'cut:export',
  'convert:plan',
  'convert:start',
  'dialog:pickSubtitle',
  'tools:start',
  'dialog:pickTrack',
  'dialog:pickVideos',
  'dialog:pickVideoFolder',
  'mkv:read',
  'mkv:save',
  'mkv:extract',
  'censor:start',
  'ai:status',
  'ai:install',
  'ai:downloadModel',
  'ai:removeModel',
  'ai:selectModel',
  'ai:uninstall',
  'ai:prepare',
  'ai:points',
  'ai:removeObject',
  'ai:reset',
  'ai:track',
  'ai:export',
  'transcribe:status',
  'transcribe:install',
  'transcribe:downloadModel',
  'transcribe:removeModel',
  'transcribe:installSpeakers',
  'transcribe:removeSpeakers',
  'transcribe:openSpeakerPage',
  'transcribe:speakers',
  'transcribe:selectModel',
  'transcribe:uninstall',
  'transcribe:start',
  'transcribe:fromLink',
  'transcribe:cues',
  'transcribe:burn',
  'transcribe:batch',
  'transcribe:export',
  'app:setLanguage',
  'app:restart',
  'app:info',
  'app:licenses',
  'app:setGlass',
  'app:setTitleBar',
];

const EVENT_CHANNELS = ['queue:update', 'download:historyChanged', 'app:openInCut', 'ai:statusChanged', 'transcribe:statusChanged', 'update:status'];

contextBridge.exposeInMainWorld('vitool', {
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.includes(channel)) {
      throw new Error(`Kanal nicht erlaubt: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, callback) {
    if (!EVENT_CHANNELS.includes(channel)) {
      throw new Error(`Kanal nicht erlaubt: ${channel}`);
    }
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  // Einmal beim Start und synchron, damit jede Seite ihre Texte schon beim Laden übersetzen kann.
  i18n: ipcRenderer.sendSync('i18n:get'),
});
