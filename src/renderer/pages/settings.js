// Bereich Einstellungen: Sprache, Standard-Download-Ordner und Infos zu Vitool.
import { el, pageHeader } from '../utils/dom.js';
import { t, LANGUAGE, formatDate } from '../utils/i18n.js';
import { THEMES, applyTheme, applyGlass } from '../utils/themes.js';
import { showLicenses } from '../components/license-dialog.js';

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

// Ein Theme wirkt sofort, ohne Neustart.
async function chooseTheme(id) {
  const theme = applyTheme(id);
  // Mit Glas muss Windows erfahren, ob das neue Theme hell oder dunkel ist.
  if (document.documentElement.hasAttribute('data-glass')) applyGlass(true);
  parts.themes.forEach((tile) => {
    const active = tile.dataset.theme === theme;
    tile.classList.toggle('active', active);
    tile.setAttribute('aria-pressed', String(active));
  });
  settings = await invoke('settings:set', { theme });
}

function themeTile(theme, current) {
  const swatch = el('span', { class: 'theme-swatch' }, ...theme.colors.slice(1).map((color) => {
    const dot = el('span', {});
    dot.style.background = color;
    return dot;
  }));
  swatch.style.background = theme.colors[0];
  const tile = el('button', {
    class: `theme-tile ${theme.id === current ? 'active' : ''}`,
    'aria-pressed': String(theme.id === current),
    onclick: () => chooseTheme(theme.id),
  }, swatch, el('span', {}, theme.name));
  tile.dataset.theme = theme.id;
  return tile;
}

async function chooseFolder() {
  const folder = await invoke('dialog:pickFolder', settings.downloadDir);
  if (!folder) return;
  settings = await invoke('settings:set', { downloadDir: folder });
  parts.folder.textContent = folder;
  parts.folder.title = folder;
}

// Kurz genug für eine Zeile: ohne Copyright-Hinweis und ohne Angaben in Klammern.
const shortVersion = (version) => (version ?? '').replace(/\s+Copyright.*$/i, '').replace(/\s*\(.*\)$/, '').replace(/^ffmpeg version\s+/i, '');

const SHOWN_TOOLS = ['ytdlp', 'ffmpeg', 'deno'];
// Die letzte Meldung je Programm übersteht das Neuaufbauen der Liste.
const toolMessages = {};

// Eine eigene Kopie von Vitool lässt sich aktualisieren. Liegt ein Programm nur systemweit vor,
// kann Vitool eine eigene Kopie laden, die danach Vorrang hat.
function toolRow(tool) {
  const source = tool.source === 'vitool' ? t('von Vitool eingerichtet') : tool.source === 'system' ? t('systemweit installiert') : t('fehlt');
  const status = el('span', { class: 'muted' }, toolMessages[tool.id] ?? '');
  const busy = (button, text) => {
    button.disabled = true;
    button.textContent = text;
  };
  let action = null;
  if (tool.id === 'ytdlp' && tool.source === 'vitool') {
    action = el('button', {
      class: 'button small',
      onclick: async () => {
        busy(action, t('Sucht Update …'));
        const response = await invoke('tools:updateYtDlp');
        toolMessages[tool.id] = response.ok ? response.message : response.error;
        renderTools();
      },
    }, t('Aktualisieren'));
  } else if (tool.source !== 'vitool') {
    action = el('button', {
      class: 'button small',
      title: tool.source === 'system' ? t('Vitool nutzt dann seine eigene Kopie, die es selbst aktuell halten kann.') : '',
      onclick: async () => {
        busy(action, t('Lädt …'));
        const response = await invoke('tools:install', [tool.id]);
        toolMessages[tool.id] = !response.ok && !response.canceled ? response.error : '';
        renderTools();
      },
    }, tool.source === 'system' ? t('Eigene Kopie laden') : t('Einrichten'));
  }
  return el('div', { class: 'folder-row tool-setting' },
    el('strong', {}, tool.label),
    el('span', { class: 'folder-path', title: tool.version ?? '' }, tool.found ? shortVersion(tool.version) : '–'),
    el('span', { class: 'muted' }, source),
    status,
    action);
}

// Je nach Stand ein Satz und der passende nächste Schritt. Installieren startet Vitool neu,
// deshalb wird vorher gefragt, wenn noch Aufträge laufen.
function renderUpdate(status) {
  const button = (text, onclick, primary = false) => el('button', { class: `button small ${primary ? 'primary' : ''}`, onclick }, text);
  const check = button(t('Nach Updates suchen'), () => invoke('update:check'));
  const notes = button(t('Was ist neu?'), () => invoke('update:openReleases'));
  const install = async () => {
    let response = await invoke('update:install', false);
    if (response.busy && window.confirm(t('Es laufen noch Aufträge. Beim Neustart werden sie abgebrochen. Trotzdem jetzt aktualisieren?'))) {
      response = await invoke('update:install', true);
    }
  };
  const views = {
    dev: [t('Updates gibt es nur in der installierten Fassung von Vitool.')],
    idle: [t('Neue Versionen kommen über GitHub.'), check],
    none: [t('Vitool ist auf dem neuesten Stand.'), check],
    error: [status.error, check],
    checking: [t('Sucht nach Updates …')],
    available: [t('Version {version} ist verfügbar.', { version: status.version }), notes, button(t('Herunterladen'), () => invoke('update:download'), true)],
    downloading: [t('Lädt Version {version} … {percent} %', { version: status.version, percent: Math.round(status.progress ?? 0) })],
    ready: [t('Version {version} ist bereit.', { version: status.version }), notes, button(t('Neu starten und aktualisieren'), install, true)],
  };
  const [text, ...actions] = views[status.state] ?? views.idle;
  let bar = null;
  if (status.state === 'downloading') {
    const fill = el('div', { class: 'progress-fill' });
    fill.style.width = `${status.progress ?? 0}%`;
    bar = el('div', { class: 'progress update-progress' }, fill);
  }
  parts.update.replaceChildren(
    el('div', { class: 'folder-row' }, el('span', { class: status.state === 'error' ? 'update-error' : 'muted' }, text), ...actions),
    ...(bar ? [bar] : []),
  );
}

// Schalter und Stand des automatischen Updates von yt-dlp.
function renderYtdlp(status) {
  parts.autoUpdate.checked = status.auto;
  parts.autoUpdate.disabled = !status.ownCopy;
  const views = {
    checking: t('Sieht nach einer neuen Version …'),
    updating: t('Aktualisiert auf Version {version} …', { version: status.version }),
    updated: t('Auf Version {version} aktualisiert.', { version: status.version }),
    available: t('Version {version} ist verfügbar.', { version: status.version }),
    error: t('Das Nachsehen hat nicht geklappt. Vitool versucht es später noch einmal.'),
  };
  let text = views[status.state] ?? '';
  if (!text && status.checkedAt) text = t('Zuletzt nachgesehen: {date}', { date: formatDate(status.checkedAt) });
  parts.ytdlpStatus.textContent = text;
  parts.autoHint.textContent = !status.ownCopy
    ? t('Dein yt-dlp ist systemweit installiert, etwa über winget. Das kann Vitool nicht aktualisieren. Mit „Eigene Kopie laden“ oben bekommt Vitool ein eigenes yt-dlp, das es selbst aktuell hält.')
    : status.auto
      ? t('Vitool sieht höchstens einmal am Tag nach, ob es eine neue Version gibt, und lädt sie dann (etwa 20 MB). Scheitert ein Download, sieht es gleich nach und versucht es danach noch einmal.')
      : t('Vitool lädt keine Updates von selbst. Scheitert ein Download und gibt es eine neue Version, bietet Vitool das Update in der Fehlermeldung an.');
  if (status.state === 'updated') renderTools();
}

// Die Anmeldung ist freiwillig. Erst wer die Hinweise bestätigt, kann das Anmeldefenster öffnen.
function renderSignIn(status) {
  const { signedIn, open, rejected, mode } = status;
  parts.signInState.textContent = signedIn
    ? t('Angemeldet. Vitool nutzt die Anmeldung nur für YouTube.')
    : rejected
      ? t('Google hat die Anmeldung in diesem Fenster abgelehnt. Schließe es und versuche es später noch einmal.')
      : open
      ? t('Melde dich im geöffneten Fenster an. Danach schließt es sich von selbst.')
      : t('Nicht angemeldet.');
  parts.signInAgree.hidden = signedIn;
  parts.signInButton.hidden = signedIn;
  parts.signInButton.disabled = !parts.signInCheck.checked || open;
  parts.signOutButton.hidden = !signedIn;
  parts.signInUse.hidden = !signedIn;
  parts.signInMode.value = mode;
}

async function signOut() {
  parts.signOutButton.disabled = true;
  parts.signOutButton.textContent = t('Meldet ab …');
  await invoke('signin:signOut');
  parts.signOutButton.disabled = false;
  parts.signOutButton.textContent = t('Abmelden');
  parts.signInCheck.checked = false;
}

async function renderTools() {
  const { tools } = await invoke('tools:check');
  parts.tools.replaceChildren(...tools.filter((tool) => SHOWN_TOOLS.includes(tool.id)).map(toolRow));
}

function buildPage(root) {
  window.vitool.on('update:status', (status) => {
    if (parts.update) renderUpdate(status);
  });
  window.vitool.on('ytdlp:status', (status) => {
    if (parts.ytdlpStatus) renderYtdlp(status);
  });
  window.vitool.on('signin:status', (status) => {
    if (parts.signInState) renderSignIn(status);
  });
  parts = {
    tools: el('div', { class: 'stack' }),
    autoUpdate: el('input', {
      type: 'checkbox',
      onchange: async (event) => {
        settings = await invoke('settings:set', { ytdlpAutoUpdate: event.target.checked });
      },
    }),
    ytdlpStatus: el('span', { class: 'muted' }),
    autoHint: el('p', { class: 'muted' }),
    signInCard: el('section', { class: 'card stack' }),
    signInState: el('span', {}),
    signInCheck: el('input', {
      type: 'checkbox',
      onchange: () => {
        parts.signInButton.disabled = !parts.signInCheck.checked;
      },
    }),
    signInAgree: el('label', { class: 'check' }),
    signInButton: el('button', { class: 'button small primary', disabled: true, onclick: () => invoke('signin:open') }, t('Anmelden')),
    signOutButton: el('button', { class: 'button small', onclick: signOut }, t('Abmelden')),
    signInMode: el('select', {
      class: 'input',
      'aria-label': t('Anmeldung verwenden'),
      onchange: async (event) => {
        settings = await invoke('settings:set', { signInUse: event.target.value });
      },
    },
    el('option', { value: 'needed' }, t('Nur wenn ein Video sie verlangt (empfohlen)')),
    el('option', { value: 'always' }, t('Bei jedem Download von YouTube'))),
    signInUse: el('div', { class: 'stack' }),
    update: el('div', { class: 'stack' }),
    licenseRoot: el('div', {}),
    glass: el('input', {
      type: 'checkbox',
      checked: document.documentElement.hasAttribute('data-glass'),
      onchange: (event) => applyGlass(event.target.checked),
    }),
    language: el('select', {
      class: 'input',
      'aria-label': t('Sprache'),
      onchange: (event) => changeLanguage(event.target.value),
    }, ...languages.map((entry) => el('option', { value: entry.id, selected: entry.id === LANGUAGE }, entry.name))),
    notice: el('p', { class: 'notice', role: 'status', hidden: true }),
    folder: el('span', { class: 'folder-path' }),
    version: el('span', { class: 'muted' }),
    dataFolder: el('span', { class: 'folder-path' }),
    themes: THEMES.map((theme) => themeTile(theme, document.documentElement.dataset.theme)),
  };

  parts.signInAgree.append(parts.signInCheck, el('span', {}, t('Ich habe die Hinweise gelesen und möchte mich anmelden.')));
  parts.signInUse.append(
    el('label', { class: 'field' }, el('span', { class: 'muted' }, t('Anmeldung verwenden')), parts.signInMode),
    el('p', { class: 'muted' }, t('Bei „Nur wenn ein Video sie verlangt“ lädt Vitool zuerst ohne Anmeldung und nimmt sie nur für einen zweiten Versuch. So wird das Konto möglichst selten benutzt.')),
  );
  parts.signInCard.append(
    el('h2', {}, t('Anmeldung bei YouTube (freiwillig)')),
    el('p', { class: 'muted' }, t('Die meisten Videos lädt Vitool ohne Anmeldung. Gebraucht wird sie nur für Videos mit Altersbeschränkung, für private Videos, die mit deinem Konto geteilt wurden, für Videos nur für Kanalmitglieder und wenn YouTube den Zugriff für automatisiert hält.')),
    el('div', { class: 'risk-box' },
      el('strong', {}, t('Bitte vorher lesen')),
      el('ul', {},
        el('li', {}, t('yt-dlp warnt selbst davor: Wer viel mit einem angemeldeten Konto herunterlädt, riskiert, dass YouTube das Konto vorübergehend oder ganz sperrt. Nimm am besten ein Zweitkonto, nicht dein Hauptkonto.')),
        el('li', {}, t('Die Anmeldung wirkt wie ein Schlüssel zu deinem Konto. Sie bleibt nur auf diesem PC im Datenordner von Vitool und geht nur beim Download an yt-dlp, sonst an niemanden. Wer an diesen Ordner kommt, könnte sie aber nutzen.')),
        el('li', {}, t('Abmelden meldet das Konto bei Google ab und löscht die gespeicherte Anmeldung aus Vitool.')))),
    parts.signInAgree,
    el('div', { class: 'folder-row' }, parts.signInState, parts.signInButton, parts.signOutButton),
    parts.signInUse,
  );

  // Das Lizenzfenster liegt über allem, deshalb direkt im Dokument und nicht in der Seite.
  document.body.append(parts.licenseRoot);
  root.append(
    pageHeader(t('Einstellungen'), t('Sprache, Design, Speicherorte und Infos zu Vitool.')),
    el('section', { class: 'card stack' },
      el('h2', {}, t('Sprache')),
      el('label', { class: 'field' }, el('span', { class: 'muted' }, t('Oberfläche')), parts.language),
      el('p', { class: 'muted' }, t('Vitool startet nach dem Wechsel kurz neu, damit alle Texte in der neuen Sprache erscheinen.')),
      parts.notice,
    ),
    el('section', { class: 'card stack' },
      el('h2', {}, t('Design')),
      el('div', { class: 'theme-grid', role: 'group', 'aria-label': t('Farbschema') }, ...parts.themes),
      el('label', { class: 'check' }, parts.glass, el('span', {}, t('Glas-Effekt'))),
      el('p', { class: 'muted' }, t('Was hinter Vitool liegt, schimmert leicht durch den Hintergrund. Nur unter Windows 11.')),
    ),
    el('section', { class: 'card stack' },
      el('h2', {}, t('Downloads')),
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, t('Standard-Zielordner')),
        parts.folder,
        el('button', { class: 'button small', onclick: chooseFolder }, t('Ändern'))),
      el('p', { class: 'muted' }, t('Hierhin speichert Vitool Downloads und Ergebnisse aus Links.')),
    ),
    parts.signInCard,
    el('section', { class: 'card stack' },
      el('h2', {}, t('Programme')),
      parts.tools,
      el('div', { class: 'folder-row' },
        el('label', { class: 'check' }, parts.autoUpdate, el('span', {}, t('yt-dlp automatisch aktualisieren'))),
        parts.ytdlpStatus),
      parts.autoHint,
      el('p', { class: 'muted' }, t('Wenn Downloads plötzlich scheitern, hilft meist ein Update von yt-dlp: Die Seiten ändern sich oft.')),
    ),
    el('section', { class: 'card stack' },
      el('h2', {}, t('Über Vitool')),
      el('div', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Version')), parts.version),
      parts.update,
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, t('Lizenz')),
        el('span', {}, t('AGPL-3.0, freie Software')),
        el('button', { class: 'button small', onclick: () => showLicenses(parts.licenseRoot) }, t('Lizenzen anzeigen'))),
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
  async onShow(data) {
    settings = await invoke('settings:get');
    parts.folder.textContent = settings.downloadDir;
    parts.folder.title = settings.downloadDir;
    const info = await invoke('app:info');
    parts.version.textContent = info.version;
    parts.dataFolder.textContent = info.userData;
    parts.dataFolder.title = info.userData;
    renderTools();
    renderYtdlp(await invoke('ytdlp:status'));
    renderSignIn(await invoke('signin:status'));
    renderUpdate(await invoke('update:status'));
    // Aus einer Fehlermeldung heraus geöffnet: gleich zur Anmeldung.
    if (data?.section === 'signin') {
      parts.signInCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      parts.signInCard.classList.remove('flash');
      requestAnimationFrame(() => parts.signInCard.classList.add('flash'));
    }
  },
};
