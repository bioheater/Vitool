// Lautstärke einer Tonspur: messen, an eine andere Spur oder die übliche Filmlautstärke angleichen,
// von Hand lauter oder leiser stellen und als Ausschnitt mit Bild anhören.
import { el } from '../utils/dom.js';
import { formatTime } from '../utils/time.js';
import { t, LANGUAGE } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

// EBU R128, die übliche Lautheit für Fernsehen und Filme.
const STANDARD_LOUDNESS = -23;
const MAX_PEAK = -2;
const PREVIEW_SECONDS = 20;
const DB = new Intl.NumberFormat(LANGUAGE, { maximumFractionDigits: 1, minimumFractionDigits: 1, signDisplay: 'exceptZero' });
const LEVEL = new Intl.NumberFormat(LANGUAGE, { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function sameTrack(a, b) {
  return a && b && a.source === b.source && a.index === b.index;
}

function trackName(track, tracks) {
  return t('Spur {number}', { number: tracks.indexOf(track) + 1 });
}

export function formatGain(gain) {
  return `${DB.format(gain)} dB`;
}

export class VolumePanel {
  constructor({ getFiles, getTracks, onChange }) {
    this.getFiles = getFiles;
    this.getTracks = getTracks;
    this.onChange = onChange;
    this.track = null;
    this.position = 0;
    this.measuring = null;

    this.title = el('h2', {});
    this.targetSelect = el('select', { class: 'input', 'aria-label': t('Angleichen an') });
    this.matchButton = el('button', { class: 'button primary', onclick: () => this.match() }, t('Messen und angleichen'));
    this.status = el('span', { class: 'muted' });
    this.resultText = el('p', { class: 'notice', hidden: true });
    this.gainInput = el('input', {
      type: 'range',
      min: -12,
      max: 20,
      step: 0.5,
      'aria-label': t('Lautstärke'),
      oninput: () => this.setGain(Number(this.gainInput.value)),
    });
    this.gainText = el('strong', { class: 'sync-offset' });
    this.limitText = el('p', { class: 'muted', hidden: true });
    this.encodeText = el('p', { class: 'muted' });
    this.positionInput = el('input', {
      type: 'range',
      min: 0,
      step: 1,
      'aria-label': t('Stelle im Film'),
      oninput: () => this.setPosition(Number(this.positionInput.value)),
    });
    this.positionText = el('span', { class: 'muted sync-time' });
    this.previewButton = el('button', { class: 'button', onclick: () => this.preview() }, t('Ausschnitt anhören'));
    this.video = el('video', { controls: true, hidden: true, class: 'sync-video' });

    this.root = el('section', { class: 'card stack volume-panel', hidden: true },
      el('div', { class: 'section-head' },
        this.title,
        el('button', { class: 'button small', onclick: () => this.close() }, t('Schließen'))),
      el('p', { class: 'muted' }, t('Vitool misst, wie laut die Spuren im Durchschnitt klingen, und bringt diese Spur auf dieselbe Lautstärke. Das Messen liest die ganze Spur und kann bei einem Film etwas dauern.')),
      el('div', { class: 'marker-row' },
        el('span', { class: 'muted' }, t('Angleichen an')), this.targetSelect, this.matchButton, this.status),
      this.resultText,
      el('div', { class: 'sync-controls' },
        el('span', { class: 'muted' }, t('Lautstärke')),
        this.gainInput,
        this.gainText,
        el('button', { class: 'button small', onclick: () => this.setGain(0) }, t('Zurücksetzen'))),
      this.limitText,
      this.encodeText,
      el('div', { class: 'sync-controls' },
        el('span', { class: 'muted' }, t('Stelle')),
        this.positionInput,
        this.positionText,
        this.previewButton),
      this.video,
    );

    window.vitool.on('mkv:loudnessProgress', ({ file, index, part }) => {
      if (this.measuring && this.measuring.file === file && this.measuring.index === index) {
        this.status.textContent = t('Misst {track} … {percent} %', { track: this.measuring.name, percent: Math.round(part * 100) });
      }
    });
  }

  isOpenFor(track) {
    return !this.root.hidden && sameTrack(this.track, track);
  }

  open(track) {
    const tracks = this.getTracks();
    this.track = track;
    this.video.hidden = true;
    this.video.removeAttribute('src');
    this.resultText.hidden = true;
    this.status.textContent = '';
    const others = tracks.filter((entry) => entry.type === 'audio' && !sameTrack(entry, track));
    const first = others.find((entry) => entry.source === 0) ?? others[0];
    this.targetSelect.replaceChildren(
      ...others.map((entry) => el('option', { value: `${entry.source}:${entry.index}`, selected: entry === first },
        `${trackName(entry, tracks)}: ${entry.codec.toUpperCase()}${entry.language && entry.language !== 'und' ? ` · ${entry.language}` : ''}`)),
      el('option', { value: 'standard', selected: !first }, t('Übliche Filmlautstärke ({loudness} LUFS)', { loudness: STANDARD_LOUDNESS })),
    );
    this.title.textContent = t('Lautstärke: {track}', { track: `${trackName(track, tracks)}: ${track.codec.toUpperCase()}` });
    this.encodeText.textContent = t('Ist die Lautstärke geändert, wird die Spur beim Speichern neu kodiert ({codec}).', { codec: track.encodeLabel ?? 'AAC' });
    this.root.hidden = false;
    this.position = Math.min(this.position, this.duration());
    this.setPosition(this.position || this.duration() / 3);
    this.renderGain();
    this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  close() {
    this.root.hidden = true;
    this.track = null;
    this.video.pause();
  }

  refresh() {
    if (this.root.hidden) return;
    const current = this.getTracks().find((entry) => sameTrack(entry, this.track));
    if (!current) {
      this.close();
      return;
    }
    this.track = current;
    this.renderGain();
  }

  duration() {
    return (this.track?.duration ?? 60) * (this.track?.stretch ?? 1);
  }

  setPosition(seconds) {
    const max = Math.max(0, this.duration() - PREVIEW_SECONDS);
    this.position = Math.min(max, Math.max(0, seconds));
    this.positionInput.max = String(max);
    this.positionInput.value = String(this.position);
    this.positionText.textContent = `${formatTime(this.position)} / ${formatTime(this.duration())}`;
  }

  setGain(gain) {
    this.track.gain = Math.round(gain * 10) / 10;
    this.renderGain();
    this.onChange();
  }

  renderGain() {
    const gain = this.track.gain ?? 0;
    this.gainInput.value = String(gain);
    this.gainText.textContent = formatGain(gain);
    // Mit bekannter Spitze lässt sich sagen, ob der Begrenzer wirklich eingreift.
    const peak = this.track.measured?.peak;
    const limits = gain > 0 && (peak === undefined || peak === null || peak + gain > MAX_PEAK);
    this.limitText.hidden = !limits;
    this.limitText.textContent = peak === undefined || peak === null
      ? t('Damit nichts übersteuert, fängt Vitool die lautesten Stellen sanft ab.')
      : t('Die lauteste Stelle läge bei {peak} dB. Damit nichts übersteuert, fängt Vitool sie sanft ab.', { peak: LEVEL.format(peak + gain) });
  }

  async measure(track) {
    if (track.measured) return track.measured;
    const tracks = this.getTracks();
    this.measuring = { file: this.getFiles()[track.source], index: track.index, name: trackName(track, tracks) };
    this.status.textContent = t('Misst {track} …', { track: this.measuring.name });
    const response = await invoke('mkv:loudness', { file: this.measuring.file, index: track.index, duration: track.duration });
    this.measuring = null;
    if (!response.ok) throw new Error(response.error);
    track.measured = { loudness: response.loudness, peak: response.peak };
    return track.measured;
  }

  async match() {
    const tracks = this.getTracks();
    const value = this.targetSelect.value;
    const target = value === 'standard' ? null : tracks.find((entry) => `${entry.source}:${entry.index}` === value);
    this.matchButton.disabled = true;
    try {
      const own = await this.measure(this.track);
      const targetLoudness = target ? (await this.measure(target)).loudness : STANDARD_LOUDNESS;
      // Eine Lautstärkeänderung der Zielspur selbst zählt mit, sie klingt ja später so.
      const goal = targetLoudness + (target?.gain ?? 0);
      const wanted = Math.round((goal - own.loudness) * 2) / 2;
      const gain = Math.max(-12, Math.min(20, wanted));
      const parts = [
        t('Diese Spur: {loudness} LUFS, lauteste Stelle {peak} dB.', { loudness: LEVEL.format(own.loudness), peak: LEVEL.format(own.peak ?? 0) }),
        target
          ? t('{track}: {loudness} LUFS.', { track: trackName(target, tracks), loudness: LEVEL.format(goal) })
          : t('Üblich für Filme sind {loudness} LUFS.', { loudness: STANDARD_LOUDNESS }),
      ];
      if (Math.abs(gain) < 0.5) parts.push(t('Die Spuren sind schon gleich laut.'));
      else if (gain > 0) parts.push(t('Diese Spur ist leiser. Vitool macht sie um {gain} dB lauter.', { gain: LEVEL.format(gain) }));
      else parts.push(t('Diese Spur ist lauter. Vitool macht sie um {gain} dB leiser.', { gain: LEVEL.format(-gain) }));
      if (gain !== wanted) parts.push(t('Der Unterschied ist größer als möglich, deshalb wird er nur teilweise ausgeglichen.'));
      this.resultText.textContent = parts.join(' ');
      this.resultText.hidden = false;
      this.status.textContent = '';
      this.setGain(Math.abs(gain) < 0.5 ? 0 : gain);
    } catch (error) {
      this.status.textContent = error.message;
    } finally {
      this.matchButton.disabled = false;
    }
  }

  async preview() {
    const files = this.getFiles();
    const tracks = this.getTracks();
    const video = tracks.find((track) => track.type === 'video' && track.source === 0) ?? tracks.find((track) => track.type === 'video');
    if (!video) {
      this.status.textContent = t('Für einen Ausschnitt braucht die Datei eine Videospur.');
      return;
    }
    this.previewButton.disabled = true;
    this.previewButton.textContent = t('Erstellt Ausschnitt …');
    const response = await invoke('mkv:syncPreview', {
      video: { file: files[video.source], index: video.index },
      track: {
        file: files[this.track.source],
        index: this.track.index,
        offset: this.track.offset ?? 0,
        stretch: this.track.stretch ?? 1,
        sampleRate: this.track.sampleRate,
        gain: this.track.gain ?? 0,
      },
      start: this.position,
      length: PREVIEW_SECONDS,
    });
    this.previewButton.disabled = false;
    this.previewButton.textContent = t('Ausschnitt anhören');
    if (!response.ok) {
      this.status.textContent = response.error;
      return;
    }
    this.status.textContent = '';
    this.video.src = response.url;
    this.video.hidden = false;
    this.video.play().catch(() => {});
  }
}
