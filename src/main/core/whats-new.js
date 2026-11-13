// "Was ist neu": Nach einem Update zeigt Vitool einmal, was sich seit der zuletzt gesehenen Version geändert hat.
// Die Texte liegen in src/whats-new.json, kurz und nur mit dem, was man beim Benutzen merkt.
const { app } = require('electron');
const notes = require('../../whats-new.json');
const { isNewer } = require('./versions');
const { currentLanguage } = require('./i18n');

function register({ ipcMain, store }) {
  const current = app.getVersion();
  const language = currentLanguage();
  const describe = (entry) => ({ version: entry.version, items: entry[language] ?? entry.de });
  const upTo = (entry) => !isNewer(entry.version, current);

  // Bei einer frischen Installation gibt es nichts nachzuholen. Gab es die Daten schon, fehlt aber die zuletzt
  // gesehene Version, kommt das Update von einer Version, die sich das noch nicht gemerkt hat.
  function pending() {
    const last = store.get('lastSeenVersion');
    if (!last && !store.existed) return [];
    return notes.filter((entry) => upTo(entry) && (last ? isNewer(entry.version, last) : entry.version === current));
  }

  ipcMain.handle('app:whatsNew', () => {
    const entries = pending();
    if (!entries.length) store.set('lastSeenVersion', current);
    return { version: current, entries: entries.map(describe) };
  });
  ipcMain.handle('app:whatsNewSeen', () => store.set('lastSeenVersion', current));
  // Zum Nachlesen in den Einstellungen: alles bis zur laufenden Version, das Neueste zuerst.
  ipcMain.handle('app:changelog', () => ({ version: current, entries: notes.filter(upTo).map(describe) }));
}

module.exports = { register };
