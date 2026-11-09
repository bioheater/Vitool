// Bereich Schneiden: Datei laden, Abschnitte setzen und exportieren.
import { el, pageHeader } from '../utils/dom.js';
import { folderOf } from '../utils/path.js';
import { formatTime } from '../utils/time.js';
import { createFileDrop } from '../components/file-drop.js';
import { createSendTo } from '../components/send-to.js';
import { MediaPlayer } from '../components/media-player.js';
import { SectionEditor } from '../components/section-editor.js';
import { t } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const state = { media: null, mode: 'fast', folder: null, visible: false };
let parts = {};
let player = null;
let editor = null;

const MODE_HINTS = {
  fast: t('Dauert nur Sekunden und behält die volle Qualität. Der Schnitt beginnt am nächsten passenden Bild und kann deshalb etwas abweichen.'),
  exact: t('Trifft die Zeiten genau, dauert aber länger, da neu kodiert wird. Das Ergebnis ist eine MP4-Datei.'),
};

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

async function openFile(filePath) {
  setMessage('');
  const response = await invoke('media:probe', filePath);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }

  const { media } = response;
  state.media = media;
  state.folder = folderOf(media.path);

  parts.name.textContent = media.name;
  parts.name.title = media.path;
  parts.info.textContent = [
    formatTime(media.duration),
    media.height ? `${media.width} × ${media.height}` : t('Nur Audio'),
  ].join(' · ');
  parts.folder.textContent = state.folder;
  parts.folder.title = state.folder;

  editor.load(media.duration);
  editor.ensureRange();
  player.load(media);
  parts.drop.hidden = true;
  parts.workspace.hidden = false;
}

function closeFile() {
  player.clear();
  state.media = null;
  setMessage('');
  parts.workspace.hidden = true;
  parts.drop.hidden = false;
}

function setMode(mode) {
  state.mode = mode;
  parts.modeFast.classList.toggle('active', mode === 'fast');
  parts.modeExact.classList.toggle('active', mode === 'exact');
  parts.modeFast.setAttribute('aria-pressed', String(mode === 'fast'));
  parts.modeExact.setAttribute('aria-pressed', String(mode === 'exact'));
  parts.modeHint.textContent = MODE_HINTS[mode];
}

async function chooseFolder() {
  const folder = await invoke('dialog:pickFolder', state.folder);
  if (!folder) return;
  state.folder = folder;
  parts.folder.textContent = folder;
  parts.folder.title = folder;
}

async function exportFile() {
  const response = await invoke('cut:export', {
    filePath: state.media.path,
    sections: editor.ranges,
    mode: state.mode,
    merge: editor.merge && editor.ranges.length > 1,
    folder: state.folder,
  });
  setMessage(response.ok ? '' : response.error);
}

function onKeyDown(event) {
  if (!state.visible || !state.media) return;
  if (event.target.closest('input, select, [role="slider"]')) return;

  const { video } = player;
  const key = event.key.toLowerCase();
  if (key === 'i') editor.setEdge('start', video.currentTime);
  else if (key === 'o') editor.setEdge('end', video.currentTime);
}

function fullRange(duration, last) {
  if (!last) return { start: 0, end: duration };
  const start = Math.min(last.end, Math.max(0, duration - 10));
  return { start, end: Math.min(duration, start + 30) };
}

function buildPage(root) {
  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    drop: createFileDrop({
      onFile: openFile,
      features: [
        { iconName: 'bolt', title: t('Blitzschnell'), text: t('Ohne Neukodierung in Sekunden fertig') },
        { iconName: 'target', title: t('Auf den Punkt'), text: t('Exakt schneiden, wenn es genau sein muss') },
        { iconName: 'layers', title: t('Mehrere Abschnitte'), text: t('Einzeln speichern oder zusammenfügen') },
      ],
    }),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    info: el('p', { class: 'muted' }),
    modeFast: el('button', { class: 'segment', onclick: () => setMode('fast') }, t('Schnell')),
    modeExact: el('button', { class: 'segment', onclick: () => setMode('exact') }, t('Exakt')),
    modeHint: el('p', { class: 'muted' }),
    folder: el('span', { class: 'folder-path' }),
  };

  player = new MediaPlayer();
  const { video } = player;
  editor = new SectionEditor({ video, onMessage: setMessage, createRange: fullRange });

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-text' }, parts.name, parts.info),
      el('div', { class: 'file-actions' },
        createSendTo({ getPath: () => state.media?.path, exclude: 'cut' }),
        el('button', { class: 'button small', onclick: closeFile }, t('Andere Datei'))),
    ),
    el('section', { class: 'card stack' },
      player.root,
      el('div', { class: 'marker-row' },
        el('button', { class: 'button', onclick: () => editor.setEdge('start', video.currentTime) }, t('Start hier setzen')),
        el('button', { class: 'button', onclick: () => editor.setEdge('end', video.currentTime) }, t('Ende hier setzen')),
        el('span', { class: 'muted' }, t('Tasten: I = Start, O = Ende, Leertaste = Abspielen, ← → = Einzelbild')),
      ),
      editor.root,
    ),
    el('section', { class: 'card stack' },
      el('div', { class: 'segments', role: 'group', 'aria-label': t('Art des Exports') }, parts.modeFast, parts.modeExact),
      parts.modeHint,
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, t('Zielordner')),
        parts.folder,
        el('button', { class: 'button small', onclick: chooseFolder }, t('Ändern')),
      ),
      el('div', {}, el('button', { class: 'button primary large', onclick: exportFile }, t('Exportieren'))),
    ),
  );

  root.append(pageHeader(t('Schneiden'), t('Nur die besten Stellen behalten.')), parts.message, parts.drop, parts.workspace);
  setMode('fast');
  document.addEventListener('keydown', onKeyDown);
}

export default {
  id: 'cut',
  label: t('Schneiden'),
  mount: buildPage,
  onShow(data) {
    state.visible = true;
    if (data?.filePath) openFile(data.filePath);
  },
  onHide() {
    state.visible = false;
    player.video.pause();
  },
};
