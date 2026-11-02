// Bereich Einstellungen: Sprache, Standard-Download-Ordner und Infos zu Vitool.
import { el, pageHeader } from '../utils/dom.js';
import { t, LANGUAGE } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);
const { languages } = window.vitool.i18n;

let parts = {};
let settings = null;

function setNotice(text, withRestart = false) {
  parts.notice.replaceChildren(text, withRestart
    ? el('button', { class: 'button small', onclick: () => invoke('app:restart') }, t('Jetzt neu starten'))
    : '');
  parts.notice.hidden = !text;
}

// Ein Wechsel startet Vitool neu. Läuft gerade etwas, wartet der Neustart, bis man ihn auslöst.
async function changeLanguage(language) {
  if (language === LANGUAGE) {
    setNotice('');
    return;
  }
  const response = await invoke('app:setLanguage', language);
  if (response.restartLater) {
    setNotice(t('Gespeichert. Gerade laufen noch Aufgaben, die Sprache wechselt beim nächsten Start.'), true);
  }
}

async function chooseFolder() {
  const folder = await invoke('dialog:pickFolder', settings.downloadDir);
  if (!folder) return;
  settings = await invoke('settings:set', { downloadDir: folder });
  parts.folder.textContent = folder;
  parts.folder.title = folder;
}

function buildPage(root) {
  parts = {
    language: el('select', {
      class: 'input',
      'aria-label': t('Sprache'),
      onchange: (event) => changeLanguage(event.target.value),
    }, ...languages.map((entry) => el('option', { value: entry.id, selected: entry.id === LANGUAGE }, entry.name))),
    notice: el('p', { class: 'notice', role: 'status', hidden: true }),
    folder: el('span', { class: 'folder-path' }),
    version: el('span', { class: 'muted' }),
    dataFolder: el('span', { class: 'folder-path' }),
  };

  root.append(
    pageHeader(t('Einstellungen'), t('Sprache, Speicherorte und Infos zu Vitool.')),
    el('section', { class: 'card stack' },
      el('h2', {}, t('Sprache')),
      el('label', { class: 'field' }, el('span', { class: 'muted' }, t('Oberfläche')), parts.language),
      el('p', { class: 'muted' }, t('Vitool startet nach dem Wechsel kurz neu, damit alle Texte in der neuen Sprache erscheinen.')),
      parts.notice,
    ),
    el('section', { class: 'card stack' },
      el('h2', {}, t('Downloads')),
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, t('Standard-Zielordner')),
        parts.folder,
        el('button', { class: 'button small', onclick: chooseFolder }, t('Ändern'))),
      el('p', { class: 'muted' }, t('Hierhin speichert Vitool Downloads und Ergebnisse aus Links.')),
    ),
    el('section', { class: 'card stack' },
      el('h2', {}, t('Über Vitool')),
      el('div', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Version')), parts.version),
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, t('Datenordner')),
        parts.dataFolder,
        el('button', { class: 'button small', onclick: () => invoke('shell:openFile', parts.dataFolder.textContent) }, t('Öffnen'))),
      el('p', { class: 'muted' }, t('Dort liegen Einstellungen, Verlauf und die Zusatzpakete für KI-Maske und Transkribieren.')),
    ),
  );
}

export default {
  id: 'settings',
  label: t('Einstellungen'),
  bottom: true,
  mount: buildPage,
  async onShow() {
    settings = await invoke('settings:get');
    parts.folder.textContent = settings.downloadDir;
    parts.folder.title = settings.downloadDir;
    const info = await invoke('app:info');
    parts.version.textContent = info.version;
    parts.dataFolder.textContent = info.userData;
    parts.dataFolder.title = info.userData;
  },
};
