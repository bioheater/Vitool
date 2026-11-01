// Startet die Oberfläche: Seitenleiste, Seitenwechsel, Warteschlange und Start-Prüfung.
import downloadPage from './pages/download.js';
import cutPage from './pages/cut.js';
import convertPage from './pages/convert.js';
import toolsPage from './pages/tools.js';
import mkvPage from './pages/mkv.js';
import { mountQueuePanel } from './components/queue-panel.js';
import { checkTools } from './components/tools-dialog.js';
import { icon } from './utils/dom.js';
import { ICONS } from './utils/icons.js';

// Neue Bereiche: Seite anlegen und hier eintragen.
const pages = [downloadPage, cutPage, convertPage, toolsPage, mkvPage];

const nav = document.getElementById('nav');
const pageRoot = document.getElementById('page');
const navButtons = new Map();
const pageRoots = new Map();

function showPage(id, data) {
  pages.forEach((page) => {
    const active = page.id === id;
    navButtons.get(page.id).classList.toggle('active', active);
    navButtons.get(page.id).setAttribute('aria-current', active ? 'page' : 'false');
    pageRoots.get(page.id).hidden = !active;
    if (active) page.onShow?.(data);
    else page.onHide?.();
  });
}

pages.forEach((page) => {
  const button = document.createElement('button');
  button.className = 'nav-item';
  button.append(icon(ICONS[page.id]), page.label);
  button.addEventListener('click', () => showPage(page.id));
  nav.append(button);
  navButtons.set(page.id, button);

  const root = document.createElement('div');
  root.hidden = true;
  pageRoot.append(root);
  pageRoots.set(page.id, root);
  page.mount(root);
});

window.vitool.on('app:openInCut', (filePath) => showPage('cut', { filePath }));

// Eine Datei, die neben einer Ablagefläche landet, soll nichts auslösen.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

mountQueuePanel(document.getElementById('queue'));
showPage('download');
checkTools(document.getElementById('tools-dialog'));
