// Werkzeug Anpassen: drehen, spiegeln, schwarze Ränder entfernen, beruhigen und Tempo ändern.
// Drehen, Spiegeln, Ränder und Tempo zeigt die Vorschau gleich am Video, das Beruhigen erst das Ergebnis.
import { el } from '../utils/dom.js';
import { formatTime } from '../utils/time.js';
import { frameButtons } from './video-controls.js';
import { volumeControl } from '../utils/volume.js';
import { t, LANGUAGE } from '../utils/i18n.js';

const PREVIEW_HEIGHT = 380;
const SPEED_FORMAT = new Intl.NumberFormat(LANGUAGE, { maximumFractionDigits: 2 });
const SPEEDS = [
  { value: 0.25, note: t('Zeitlupe') },
  { value: 0.5, note: t('Zeitlupe') },
  { value: 0.75, note: null },
  { value: 1, note: t('normal') },
  { value: 1.25, note: null },
  { value: 1.5, note: null },
  { value: 2, note: null },
  { value: 3, note: null },
  { value: 4, note: t('Zeitraffer') },
  { value: 8, note: t('Zeitraffer') },
];
// Ab dieser Bildrate wirkt eine halbe Geschwindigkeit noch flüssig.
const SMOOTH_SOURCE_FPS = 48;

const initialState = () => ({
  rotate: 0,
  flipH: false,
  flipV: false,
  crop: null,
  useCrop: false,
  detecting: false,
  detected: false,
  stabilize: 'off',
  speed: 1,
  smooth: false,
  keepAudio: true,
});

function segments(label, choices, onSelect) {
  const buttons = choices.map(({ value, text }) => el('button', { class: 'segment', onclick: () => onSelect(value) }, text));
  return {
    root: el('div', { class: 'segments', role: 'group', 'aria-label': label }, ...buttons),
    render: (current) => buttons.forEach((button, index) => {
      const active = choices[index].value === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }),
  };
}

export class AdjustEditor {
  constructor({ player, onChange }) {
    this.player = player;
    this.video = player.video;
    this.onChange = onChange;
    this.media = null;
    this.active = false;
    this.state = initialState();

    this.cropBox = el('div', { class: 'adjust-crop', hidden: true });
    player.root.append(this.cropBox);

    this.rotateButtons = segments(t('Drehen'), [
      { value: 0, text: t('Nicht drehen') },
      { value: 270, text: t('90° nach links') },
      { value: 90, text: t('90° nach rechts') },
      { value: 180, text: '180°' },
    ], (value) => this.set({ rotate: value }));
    this.flipH = el('input', { type: 'checkbox', onchange: (event) => this.set({ flipH: event.target.checked }) });
    this.flipV = el('input', { type: 'checkbox', onchange: (event) => this.set({ flipV: event.target.checked }) });

    this.detectButton = el('button', { class: 'button small', onclick: () => this.detect() }, t('Ränder suchen'));
    this.cropToggle = el('input', { type: 'checkbox', onchange: (event) => this.set({ useCrop: event.target.checked }) });
    this.cropLabel = el('label', { class: 'check', hidden: true }, this.cropToggle, el('span', {}, t('Ränder entfernen')));
    this.cropInfo = el('p', { class: 'muted', hidden: true });

    this.stabilizeButtons = segments(t('Beruhigen'), [
      { value: 'off', text: t('Aus') },
      { value: 'light', text: t('Leicht') },
      { value: 'strong', text: t('Stark') },
    ], (value) => this.set({ stabilize: value }));
    this.stabilizeHint = el('p', { class: 'muted', hidden: true });

    this.speed = el('select', { class: 'input', 'aria-label': t('Tempo'), onchange: (event) => this.set({ speed: Number(event.target.value) }) },
      ...SPEEDS.map(({ value, note }) => el('option', { value: String(value), selected: value === 1 },
        `${SPEED_FORMAT.format(value)}×${note ? ` (${note})` : ''}`)));
    this.smooth = el('input', { type: 'checkbox', onchange: (event) => this.set({ smooth: event.target.checked }) });
    this.smoothLabel = el('label', { class: 'check', hidden: true }, this.smooth,
      el('span', {}, t('Zwischenbilder berechnen'), el('small', { class: 'muted' }, t('Flüssiger, rechnet aber ein Vielfaches länger. Bei schnellen Bewegungen entstehen manchmal Schlieren.'))));
    this.speedHint = el('p', { class: 'muted', hidden: true });
    this.keepAudio = el('input', { type: 'checkbox', checked: true, onchange: (event) => this.set({ keepAudio: event.target.checked }) });
    this.audioLabel = el('label', { class: 'check', hidden: true }, this.keepAudio,
      el('span', {}, t('Ton behalten'), el('small', { class: 'muted' }, t('Die Tonhöhe bleibt gleich, nur das Tempo ändert sich.'))));

    this.result = el('p', { class: 'notice adjust-result' });

    const group = (title, ...children) => el('div', { class: 'adjust-group' }, el('h3', {}, title), ...children);
    this.root = el('section', { class: 'card stack adjust-panel' },
      group(t('Drehen und spiegeln'),
        this.rotateButtons.root,
        el('div', { class: 'option-row' },
          el('label', { class: 'check' }, this.flipH, el('span', {}, t('Horizontal spiegeln'))),
          el('label', { class: 'check' }, this.flipV, el('span', {}, t('Vertikal spiegeln'))))),
      group(t('Schwarze Ränder'),
        el('div', { class: 'option-row' }, this.detectButton, this.cropLabel),
        this.cropInfo),
      group(t('Verwackeltes beruhigen'), this.stabilizeButtons.root, this.stabilizeHint),
      group(t('Tempo'), this.speed, this.speedHint, this.smoothLabel, this.audioLabel),
      this.result);

    // Eigene Steuerleiste unter dem Bild, die des Players würde sich mitdrehen.
    this.playButton = el('button', { class: 'button small', onclick: () => (this.video.paused ? this.video.play() : this.video.pause()) });
    this.seek = el('input', {
      type: 'range', min: 0, max: 1000, step: 1, value: 0, class: 'chroma-seek', 'aria-label': t('Position'),
      oninput: () => {
        if (this.media) this.video.currentTime = (Number(this.seek.value) / 1000) * this.media.duration;
      },
    });
    this.timeLabel = el('span', { class: 'muted sync-time' });
    this.controlsRow = el('div', { class: 'marker-row chroma-controls', hidden: true },
      this.playButton, this.seek, this.timeLabel, volumeControl(), ...frameButtons(this.video));
    ['play', 'pause', 'timeupdate', 'loadedmetadata'].forEach((name) => this.video.addEventListener(name, () => this.renderPlayback()));

    this.video.addEventListener('loadedmetadata', () => {
      if (this.active) this.video.playbackRate = this.state.speed;
    });
  }

  renderPlayback() {
    if (!this.active || !this.media) return;
    this.playButton.textContent = this.video.paused ? t('Abspielen') : t('Pause');
    this.seek.value = String(Math.round((this.video.currentTime / this.media.duration) * 1000) || 0);
    this.timeLabel.textContent = `${formatTime(this.video.currentTime)} / ${formatTime(this.media.duration)}`;
  }

  load(media) {
    this.media = media;
    this.state = initialState();
    this.flipH.checked = false;
    this.flipV.checked = false;
    this.cropToggle.checked = false;
    this.smooth.checked = false;
    this.keepAudio.checked = true;
    this.speed.value = '1';
    this.render();
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.render();
    this.onChange?.();
  }

  async detect() {
    const { media } = this;
    if (!media || this.state.detecting) return;
    this.set({ detecting: true });
    const response = await window.vitool.invoke('tools:detectBars', media.path);
    if (this.media !== media) return;
    if (!response.ok) {
      this.set({ detecting: false, detected: false });
      this.cropInfo.textContent = response.error;
      this.cropInfo.hidden = false;
      return;
    }
    this.cropToggle.checked = Boolean(response.crop);
    this.set({ detecting: false, detected: true, crop: response.crop, useCrop: Boolean(response.crop) });
  }

  setActive(active) {
    const { media } = this;
    const was = this.active;
    this.active = active;
    this.controlsRow.hidden = !active;
    if (!active) {
      if (was) {
        this.video.controls = true;
        this.player.root.classList.remove('crop-stage', 'adjust-stage');
        this.player.root.style.width = '';
        this.player.root.style.aspectRatio = '';
        this.player.root.style.maxHeight = '';
        this.video.style.transform = '';
        this.cropBox.hidden = true;
        this.video.playbackRate = 1;
      }
      return;
    }
    this.player.root.classList.toggle('crop-stage', Boolean(media));
    this.player.root.classList.add('adjust-stage');
    this.player.root.style.width = media ? `${(PREVIEW_HEIGHT * media.width) / media.height}px` : '';
    this.player.root.style.aspectRatio = media ? `${media.width} / ${media.height}` : '';
    this.player.root.style.maxHeight = `${PREVIEW_HEIGHT}px`;
    this.video.controls = false;
    this.renderPlayback();
    this.render();
  }

  ready() {
    const { state } = this;
    return state.rotate !== 0 || state.flipH || state.flipV || (state.useCrop && Boolean(state.crop))
      || state.stabilize !== 'off' || state.speed !== 1;
  }

  options() {
    const { state } = this;
    return {
      rotate: state.rotate,
      flipH: state.flipH,
      flipV: state.flipV,
      crop: state.useCrop ? state.crop : null,
      stabilize: state.stabilize === 'off' ? null : state.stabilize,
      speed: state.speed,
      smooth: state.speed < 1 && state.smooth,
      keepAudio: state.keepAudio,
    };
  }

  // Größe und Länge des Ergebnisses, damit klar ist, was am Ende herauskommt.
  outputSize() {
    const { media, state } = this;
    if (!media?.width) return null;
    let width = state.useCrop && state.crop ? state.crop.w : media.width;
    let height = state.useCrop && state.crop ? state.crop.h : media.height;
    if (state.rotate === 90 || state.rotate === 270) [width, height] = [height, width];
    return { width, height, duration: media.duration / state.speed };
  }

  render() {
    const { state, media } = this;
    this.rotateButtons.render(state.rotate);
    this.stabilizeButtons.render(state.stabilize);

    // Ränder
    this.detectButton.disabled = state.detecting || !media;
    this.detectButton.textContent = state.detecting ? t('Sucht …') : state.detected ? t('Erneut suchen') : t('Ränder suchen');
    this.cropLabel.hidden = !state.crop;
    if (state.detecting) {
      this.cropInfo.textContent = t('Prüft mehrere Stellen im Video …');
    } else if (state.detected && state.crop && media) {
      this.cropInfo.textContent = t('Gefunden: Bildbereich {width} × {height} statt {fullWidth} × {fullHeight}.', {
        width: state.crop.w, height: state.crop.h, fullWidth: media.width, fullHeight: media.height,
      });
    } else if (state.detected) {
      this.cropInfo.textContent = t('Keine schwarzen Ränder gefunden.');
    } else {
      this.cropInfo.textContent = '';
    }
    this.cropInfo.hidden = !this.cropInfo.textContent;

    // Beruhigen
    this.stabilizeHint.textContent = state.stabilize === 'off' ? ''
      : t('Gleicht Wackler von Aufnahmen aus der Hand aus. Dafür wird das Bild etwas vergrößert, stark mehr als leicht. Die Wirkung siehst du erst im Ergebnis.');
    this.stabilizeHint.hidden = !this.stabilizeHint.textContent;

    // Tempo
    const slow = state.speed < 1;
    const choppy = slow && (media?.fps ?? 30) * state.speed < SMOOTH_SOURCE_FPS / 2 + 1;
    this.smoothLabel.hidden = !slow;
    this.speedHint.textContent = choppy && !state.smooth
      ? t('Bei {fps} Bildern pro Sekunde ruckelt eine so starke Zeitlupe sichtbar, weil jedes Bild länger stehen bleibt. Flüssig wird sie mit Aufnahmen in 60 oder mehr Bildern pro Sekunde oder mit berechneten Zwischenbildern.', { fps: Math.round(media?.fps ?? 30) })
      : '';
    this.speedHint.hidden = !this.speedHint.textContent;
    this.audioLabel.hidden = !media?.hasAudio || state.speed === 1;

    // Ergebnis
    const size = this.outputSize();
    this.result.textContent = size
      ? t('Ergebnis: {width} × {height}, {duration}', { width: size.width, height: size.height, duration: formatTime(size.duration) })
      : '';
    this.result.hidden = !this.ready() || !size;

    if (this.active) this.renderPreview();
  }

  // Vorschau: Drehen und Spiegeln über CSS, die Ränder als abgedunkelter Bereich, das Tempo über den Player.
  renderPreview() {
    const { state, media } = this;
    if (!media?.width) return;
    const aspect = media.width / media.height;
    const sideways = state.rotate === 90 || state.rotate === 270;
    const scale = sideways ? Math.min(aspect, 1 / aspect) : 1;
    const transform = [
      `rotate(${state.rotate}deg)`,
      `scale(${(state.flipH ? -1 : 1) * scale}, ${(state.flipV ? -1 : 1) * scale})`,
    ].join(' ');
    this.video.style.transform = transform;
    const crop = state.useCrop ? state.crop : null;
    this.cropBox.hidden = !crop;
    if (crop) {
      Object.assign(this.cropBox.style, {
        left: `${(crop.x / media.width) * 100}%`,
        top: `${(crop.y / media.height) * 100}%`,
        width: `${(crop.w / media.width) * 100}%`,
        height: `${(crop.h / media.height) * 100}%`,
        transform,
        transformOrigin: `${((media.width / 2 - crop.x) / crop.w) * 100}% ${((media.height / 2 - crop.y) / crop.h) * 100}%`,
      });
    }
    this.video.playbackRate = state.speed;
  }
}
