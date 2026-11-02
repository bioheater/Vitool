// Kontrollierte Brücke: Die Oberfläche darf nur diese Kanäle benutzen.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE_CHANNELS = [
  'tools:check',
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
];

const EVENT_CHANNELS = ['queue:update', 'download:historyChanged', 'app:openInCut', 'ai:statusChanged'];

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
});
