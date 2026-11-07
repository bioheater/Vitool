// Zeigt die Lizenzübersicht und den vollständigen AGPL-Text in einem Fenster.
// Die Übersicht ist Markdown. Umgesetzt wird nur, was die Datei braucht: Überschriften, Absätze,
// Listen und Tabellen. Links und Hervorhebungen werden zu schlichtem Text, es entsteht kein HTML aus der Datei.
import { el } from '../utils/dom.js';
import { t } from '../utils/i18n.js';

const plain = (text) => text
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/[*`]/g, '')
  .trim();

function markdownBlocks(markdown) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  let table = null;
  const flush = () => {
    if (paragraph.length) blocks.push(el('p', {}, plain(paragraph.join(' '))));
    paragraph = [];
    list = null;
    table = null;
  };
  markdown.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (!trimmed) {
      flush();
    } else if (heading) {
      flush();
      blocks.push(el(`h${heading[1].length + 1}`, {}, plain(heading[2])));
    } else if (trimmed.startsWith('|')) {
      if (paragraph.length || list) flush();
      // Die Trennzeile unter dem Kopf trägt keinen Inhalt.
      if (/^\|[\s:|-]+\|$/.test(trimmed)) return;
      const cells = trimmed.slice(1, -1).split('|').map((cell) => plain(cell));
      if (!table) {
        table = el('table', { class: 'license-table' });
        table.append(el('tr', {}, ...cells.map((cell) => el('th', {}, cell))));
        blocks.push(table);
      } else {
        table.append(el('tr', {}, ...cells.map((cell) => el('td', {}, cell))));
      }
    } else if (/^[-*]\s+/.test(trimmed)) {
      if (paragraph.length || table) flush();
      if (!list) {
        list = el('ul', { class: 'license-list' });
        blocks.push(list);
      }
      list.append(el('li', {}, plain(trimmed.replace(/^[-*]\s+/, ''))));
    } else if (list && /^\s{2,}/.test(line)) {
      // Fortsetzung des letzten Listenpunkts.
      list.lastChild.textContent += ` ${plain(trimmed)}`;
    } else {
      if (list || table) flush();
      paragraph.push(trimmed);
    }
  });
  flush();
  return blocks;
}

export async function showLicenses(root) {
  const { notice, license } = await window.vitool.invoke('app:licenses');
  const body = el('div', { class: 'license-body' });
  const showNotice = () => body.replaceChildren(...markdownBlocks(notice || t('Die Lizenzübersicht wurde nicht gefunden.')));
  const showLicense = () => body.replaceChildren(el('pre', { class: 'license-text' }, license || t('Der Lizenztext wurde nicht gefunden.')));
  const tabs = [
    el('button', { class: 'segment active', onclick: () => select(0) }, t('Übersicht')),
    el('button', { class: 'segment', onclick: () => select(1) }, t('AGPL-3.0 vollständig')),
  ];
  function select(index) {
    tabs.forEach((tab, tabIndex) => tab.classList.toggle('active', tabIndex === index));
    if (index === 0) showNotice();
    else showLicense();
    body.scrollTop = 0;
  }
  const close = () => root.replaceChildren();
  const overlay = el('div', {
    class: 'overlay',
    onclick: (event) => {
      if (event.target === overlay) close();
    },
  },
  el('div', { class: 'dialog license-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Lizenzen') },
    el('div', { class: 'section-head' },
      el('h2', {}, t('Lizenzen')),
      el('div', { class: 'segments', role: 'group' }, ...tabs)),
    body,
    el('div', { class: 'dialog-actions' }, el('button', { class: 'button primary', onclick: close }, t('Schließen')))));
  showNotice();
  root.replaceChildren(overlay);
}
