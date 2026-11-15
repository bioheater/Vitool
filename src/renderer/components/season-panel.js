// Mehrere Folgen auf einmal: Die Auswahl der geöffneten Datei gilt auch für weitere Dateien.
// Die Spuren jeder Datei werden einer Spur der geöffneten Datei zugeordnet: zuerst über Art und
// Reihenfolge, wenn Sprache und Format übereinstimmen, sonst über Art, Sprache und Format allein.
import { el } from '../utils/dom.js';
import { t } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);
const fileName = (filePath) => filePath.split(/[\\/]/).pop();

function signature(track) {
  return `${track.type}|${track.originalLanguage ?? track.language}|${track.codec}`;
}

function sameTypeTracks(tracks, type) {
  return tracks.filter((track) => track.type === type);
}

// Gibt für jede Spur der anderen Datei die passende Spur der geöffneten Datei zurück, oder null.
export function matchTracks(reference, target) {
  const rules = reference.filter((track) => track.source === 0);
  const used = new Set();
  const result = target.map(() => null);
  let byPosition = 0;
  target.forEach((track, index) => {
    const position = sameTypeTracks(target, track.type).indexOf(track);
    const rule = sameTypeTracks(rules, track.type)[position];
    if (rule && signature(rule) === signature(track)) {
      result[index] = rule;
      used.add(rule);
      byPosition += 1;
    }
  });
  target.forEach((track, index) => {
    if (result[index]) return;
    const rule = rules.find((entry) => !used.has(entry) && signature(entry) === signature(track));
    if (rule) {
      result[index] = rule;
      used.add(rule);
    }
  });
  const unmatched = result.filter((rule) => !rule).length;
  const missing = rules.length - used.size;
  return { result, unmatched, missing, exact: byPosition === target.length && missing === 0 };
}

// Spuren der anderen Datei mit den Einstellungen der zugeordneten Spuren.
// Versatz, Tempo und Lautstärke gelten nur für die geöffnete Datei und bleiben hier neutral.
export function planTracks(reference, target) {
  const { result } = matchTracks(reference, target);
  const tracks = target.map((track, index) => {
    const rule = result[index];
    const base = { ...track, offset: 0, stretch: 1, gain: 0 };
    return rule
      ? { ...base, keep: rule.keep, language: rule.language, name: rule.name, isDefault: rule.isDefault, forced: rule.forced, matched: true }
      : { ...base, matched: false };
  });
  // Pro Spurart nur eine Standardspur. Hat eine zugeordnete Spur sie, verliert eine übrige sie.
  ['video', 'audio', 'subtitle'].forEach((type) => {
    if (tracks.some((track) => track.type === type && track.matched && track.isDefault)) {
      tracks.filter((track) => track.type === type && !track.matched).forEach((track) => { track.isDefault = false; });
    }
  });
  return tracks;
}

export class SeasonPanel {
  constructor({ getReference, onChange }) {
    this.getReference = getReference;
    this.onChange = onChange;
    this.files = [];
    this.loadId = 0;

    this.list = el('ul', { class: 'season-list' });
    this.empty = el('p', { class: 'muted', hidden: true }, t('Im Ordner liegen keine weiteren Videos. Du kannst Dateien von woanders hinzufügen.'));
    this.allButton = el('button', { class: 'button small', onclick: () => this.selectAll() }, t('Alle auswählen'));
    this.note = el('p', { class: 'muted', hidden: true });
    this.root = el('section', { class: 'card stack' },
      el('div', { class: 'section-head' },
        el('h2', {}, t('Weitere Folgen')),
        el('span', { class: 'spacer' }),
        this.allButton,
        el('button', { class: 'button small', onclick: () => this.addFiles() }, t('Dateien hinzufügen'))),
      el('p', { class: 'muted' }, t('Welche Spuren bleiben, Sprache, Name, Standard und Erzwungen gelten auch für die ausgewählten Dateien. Vitool ordnet die Spuren nach Art, Reihenfolge, Sprache und Format zu.')),
      this.list,
      this.empty,
      this.note);
  }

  async load(filePath) {
    this.loadId += 1;
    const id = this.loadId;
    this.files = [];
    this.render();
    const siblings = await invoke('mkv:siblings', filePath);
    if (id !== this.loadId) return;
    this.files = siblings.map((path) => ({ path, selected: false, tracks: null, title: '', error: null }));
    this.render();
    this.readAll(id);
  }

  clear() {
    this.loadId += 1;
    this.files = [];
    this.render();
  }

  async readAll(id) {
    for (const file of this.files) {
      if (file.tracks || file.error) continue;
      const response = await invoke('mkv:read', file.path, 0);
      if (id !== this.loadId) return;
      if (response.ok) {
        file.tracks = response.tracks.map((track) => ({ ...track, originalLanguage: track.language }));
        file.title = response.title;
      } else {
        file.error = response.error;
        file.selected = false;
      }
      this.render();
    }
  }

  async addFiles() {
    const paths = await invoke('dialog:pickVideos');
    const known = new Set(this.files.map((file) => file.path));
    const added = paths.filter((path) => !known.has(path));
    this.files.push(...added.map((path) => ({ path, selected: true, tracks: null, title: '', error: null })));
    this.render();
    this.readAll(this.loadId);
  }

  selectAll() {
    const ready = this.files.filter((file) => !file.error);
    const all = ready.every((file) => file.selected);
    ready.forEach((file) => { file.selected = !all; });
    this.render();
  }

  status(file) {
    if (file.error) return { text: file.error, warn: true };
    if (!file.tracks) return { text: t('Liest Spuren …'), warn: false };
    const { exact, unmatched, missing } = matchTracks(this.getReference(), file.tracks);
    if (exact) return { text: t('Gleiche Spuren'), warn: false, ok: true };
    const notes = [];
    if (unmatched) notes.push(t('Spuren ohne Gegenstück: {count}, bleiben unverändert', { count: unmatched }));
    if (missing) notes.push(t('Fehlende Spuren: {count}', { count: missing }));
    // Gleiche Spuren in anderer Reihenfolge: zugeordnet, also kein Grund zur Warnung.
    if (notes.length === 0) return { text: t('Andere Reihenfolge, Spuren zugeordnet'), warn: false, ok: true };
    return { text: notes.join(' · '), warn: true };
  }

  // Ausgewählte Dateien, deren Spuren schon gelesen sind, samt Plan für das Speichern.
  selected() {
    const reference = this.getReference();
    return this.files
      .filter((file) => file.selected && file.tracks && !file.error)
      .map((file) => ({ path: file.path, title: file.title, tracks: planTracks(reference, file.tracks) }));
  }

  waiting() {
    return this.files.some((file) => file.selected && !file.tracks && !file.error);
  }

  render() {
    this.list.replaceChildren(...this.files.map((file) => {
      const status = this.status(file);
      const box = el('input', {
        type: 'checkbox',
        checked: file.selected,
        disabled: Boolean(file.error),
        'aria-label': fileName(file.path),
        onchange: () => {
          file.selected = box.checked;
          this.render();
        },
      });
      return el('li', { class: `season-row ${file.selected ? '' : 'off'}` },
        el('label', { class: 'check season-name', title: file.path }, box, el('span', {}, fileName(file.path))),
        el('span', { class: `season-status ${status.warn ? 'warn' : ''} ${status.ok ? 'ok' : ''}` }, status.text));
    }));
    const ready = this.files.filter((file) => !file.error);
    this.empty.hidden = this.files.length > 0;
    this.allButton.hidden = ready.length === 0;
    this.allButton.textContent = ready.length && ready.every((file) => file.selected) ? t('Keine auswählen') : t('Alle auswählen');
    this.renderNote();
    this.onChange?.();
  }

  // Was nur für die geöffnete Datei gilt, wird erwähnt, sobald es eingestellt ist.
  renderNote() {
    const reference = this.getReference();
    const special = reference.some((track) => track.source !== 0 || track.offset || Math.abs((track.stretch ?? 1) - 1) > 1e-6 || Math.abs(track.gain ?? 0) >= 0.05);
    const active = this.files.some((file) => file.selected);
    this.note.textContent = t('Hinzugefügte Spuren, Versatz, Tempo und Lautstärke gelten nur für die geöffnete Datei.');
    this.note.hidden = !(special && active);
  }
}
