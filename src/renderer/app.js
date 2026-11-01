// Startet die Oberfläche: Seitenleiste, Seitenwechsel, Warteschlange und Start-Prüfung.
import downloadPage from './pages/download.js';
import cutPage from './pages/cut.js';
import convertPage from './pages/convert.js';
import toolsPage from './pages/tools.js';
import { mountQueuePanel } from './components/queue-panel.js';
import { checkTools } from './components/tools-dialog.js';

const ICONS = {
  download: 'M12 3v12m0 0 5-5m-5 5-5-5M4 20h16',
  cut: 'M6 6a2.5 2.5 0 1 0 0 .01M6 18a2.5 2.5 0 1 0 0 .01M8 7.5 20 18M8 16.5 20 6',
  convert: 'M4 8h13l-3-3m6 11H7l3 3',
  tools: 'M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5L16 12l-4-4z',
};

// Neue Bereiche: Seite anlegen und hier eintragen.
const pages = [downloadPage, cutPage, convertPage, toolsPage];

const nav = document.getElementById('nav');
const pageRoot = document.getElementById('page');
const navButtons = new Map();
const pageRoots = new Map();

function icon(path) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(svgNs, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

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
