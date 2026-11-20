// Greenscreen-Editor: Farbe wählen, Regler einstellen und das Ergebnis live über dem Video sehen.
// Die Vorschau rechnet wie FFmpeg (chromakey und despill), nur in kleinerer Auflösung.
import { el } from '../utils/dom.js';
import { formatTime } from '../utils/time.js';
import { frameButtons } from './video-controls.js';
import { volumeControl } from '../utils/volume.js';
import { t, LANGUAGE } from '../utils/i18n.js';

const PREVIEW_HEIGHT = 380;
// Breiter rechnet die Vorschau nicht, damit sie auch beim Abspielen flüssig bleibt.
const WORK_WIDTH = 800;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];
const DEFAULTS = { similarity: 0.12, blend: 0.06 };
// Anteil des Randes, aus dem die Hintergrundfarbe erraten wird.
const BORDER = 0.05;

const PERCENT_FORMAT = new Intl.NumberFormat(LANGUAGE, { maximumFractionDigits: 1 });
const PERCENT = (value) => `${PERCENT_FORMAT.format(value * 100)} %`;
// Bereich und Feinheit, in denen tune() die Grenze zwischen Hinter- und Vordergrund sucht.
const TUNE_RANGE = 0.4;
const TUNE_BINS = 200;
const toHex = (value) => Math.round(value).toString(16).padStart(2, '0');

function fileUrl(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent);
  return `file:///${parts.join('/').replace(/^([a-z])%3A/i, '$1:')}`;
}

// Farbanteile wie im Export (BT.601, begrenzter Bereich), siehe main/features/chroma.js.
function uvOf(r, g, b) {
  return [128 - 0.148 * r - 0.291 * g + 0.439 * b, 128 + 0.439 * r - 0.368 * g - 0.071 * b];
}

function parseHex(color) {
  return [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
}

// Größe, mit der ein Bild die Fläche ganz füllt, wie scale=increase und crop im Export.
function coverRect(sourceWidth, sourceHeight, width, height) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  return [(width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight];
}

export class ChromaEditor {
  constructor({ player, onChange }) {
    this.player = player;
    this.video = player.video;
    this.onChange = onChange;
    this.media = null;
    this.active = false;
    this.picking = false;
    this.frameRequest = null;
    this.state = {
      color: null,
      similarity: DEFAULTS.similarity,
      blend: DEFAULTS.blend,
      despill: true,
      background: 'transparent',
      backgroundColor: '#000000',
      backgroundPath: null,
      transparentFormat: 'webm',
      view: 'result',
    };

    this.canvas = el('canvas', {
      class: 'chroma-canvas',
      hidden: true,
      onclick: (event) => this.onCanvasClick(event),
    });
    this.work = document.createElement('canvas');
    this.keyed = document.createElement('canvas');
    this.backgroundImage = new Image();
    this.backgroundImage.addEventListener('load', () => this.render());
    this.backgroundVideo = el('video', { muted: true, loop: true, preload: 'auto' });
    this.backgroundVideo.addEventListener('loadeddata', () => this.syncBackground());
    this.backgroundVideo.addEventListener('seeked', () => this.render());
    player.root.append(this.canvas);

    this.buildControls();
    this.buildPanel();

    this.video.addEventListener('loadeddata', () => {
      if (!this.state.color) this.detectColor();
      this.render();
    });
    this.video.addEventListener('seeked', () => {
      this.syncBackground();
      this.render();
    });
    this.video.addEventListener('play', () => {
      this.syncBackground();
      this.backgroundVideo.play().catch(() => {});
      this.watch();
      this.renderPlayback();
    });
    this.video.addEventListener('pause', () => {
      this.backgroundVideo.pause();
      this.renderPlayback();
    });
    this.video.addEventListener('timeupdate', () => this.renderPlayback());
  }

  // Eigene Steuerleiste unter dem Bild. Die des Players läge unter der Vorschau.
  buildControls() {
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
  }

  buildPanel() {
    const slider = (label, key, min, max, step) => {
      const value = el('span', { class: 'muted slider-value' });
      const input = el('input', {
        type: 'range', min, max, step, value: this.state[key], 'aria-label': label,
        oninput: () => {
          this.state[key] = Number(input.value);
          value.textContent = PERCENT(this.state[key]);
          this.render();
        },
      });
      value.textContent = PERCENT(this.state[key]);
      return { input, value, row: el('label', { class: 'crop-control' }, el('span', { class: 'muted slider-label' }, label), input, value) };
    };

    this.swatch = el('span', { class: 'chroma-swatch' });
    this.colorText = el('span', { class: 'muted' });
    this.pickButton = el('button', { class: 'button small', onclick: () => this.setPicking(!this.picking) }, t('Im Bild wählen'));
    this.similarity = slider(t('Toleranz'), 'similarity', 0.01, 0.4, 0.001);
    this.blend = slider(t('Weiche Kante'), 'blend', 0, 0.3, 0.001);
    this.despillToggle = el('input', {
      type: 'checkbox',
      checked: this.state.despill,
      onchange: () => {
        this.state.despill = this.despillToggle.checked;
        this.render();
      },
    });

    this.viewButtons = this.segmented(t('Ansicht'), [
      { value: 'result', text: t('Ergebnis') },
      { value: 'mask', text: t('Maske') },
      { value: 'original', text: t('Original') },
    ], () => this.state.view, (value) => {
      this.state.view = value;
      this.viewButtons.render();
      this.render();
    });

    this.backgroundButtons = this.segmented(t('Hintergrund'), [
      { value: 'transparent', text: t('Transparent') },
      { value: 'color', text: t('Farbe') },
      { value: 'media', text: t('Bild oder Video') },
    ], () => (this.state.background === 'image' || this.state.background === 'video' ? 'media' : this.state.background), (value) => {
      if (value === 'media') {
        if (this.state.backgroundPath) this.state.background = this.mediaKind(this.state.backgroundPath);
        else this.pickBackground();
      } else {
        this.state.background = value;
      }
      this.renderPanel();
      this.render();
    });
    this.colorInput = el('input', {
      type: 'color', class: 'chroma-color', value: this.state.backgroundColor, 'aria-label': t('Hintergrundfarbe'),
      oninput: () => {
        this.state.backgroundColor = this.colorInput.value;
        this.render();
      },
    });
    this.backgroundName = el('span', { class: 'folder-path' });
    this.formatButtons = this.segmented(t('Format'), [
      { value: 'webm', text: 'WebM' },
      { value: 'mov', text: t('MOV (ProRes)') },
    ], () => this.state.transparentFormat, (value) => {
      this.state.transparentFormat = value;
      this.renderPanel();
    });
    this.formatHint = el('p', { class: 'muted' });
    this.colorRow = el('div', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Farbe')), this.colorInput);
    this.mediaRow = el('div', { class: 'folder-row' },
      el('span', { class: 'muted' }, t('Datei')), this.backgroundName,
      el('button', { class: 'button small', onclick: () => this.pickBackground() }, t('Andere Datei')));
    this.transparentRow = el('div', { class: 'stack' }, this.formatButtons.root, this.formatHint);
    this.colorHint = el('p', { class: 'muted' });

    this.root = el('div', { class: 'stack' },
      el('section', { class: 'card stack' },
        el('h2', {}, t('Farbe ausstanzen')),
        el('div', { class: 'folder-row' },
          this.swatch, this.colorText, el('span', { class: 'spacer' }),
          el('button', { class: 'button small', onclick: () => this.detectColor(true) }, t('Automatisch')),
          this.pickButton),
        this.colorHint,
        this.similarity.row,
        this.blend.row,
        el('label', { class: 'check' }, this.despillToggle, el('span', {}, t('Farbsaum an den Rändern entfernen'))),
        el('div', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Ansicht')), this.viewButtons.root)),
      el('section', { class: 'card stack' },
        el('h2', {}, t('Neuer Hintergrund')),
        this.backgroundButtons.root,
        this.colorRow,
        this.mediaRow,
        this.transparentRow));
    this.renderPanel();
  }

  segmented(label, choices, current, onSelect) {
    const buttons = choices.map(({ value, text }) => el('button', { class: 'segment', onclick: () => onSelect(value) }, text));
    const root = el('div', { class: 'segments', role: 'group', 'aria-label': label }, ...buttons);
    const render = () => {
      choices.forEach(({ value }, index) => {
        buttons[index].classList.toggle('active', value === current());
        buttons[index].setAttribute('aria-pressed', String(value === current()));
      });
    };
    return { root, render };
  }

  renderPanel() {
    const { state } = this;
    this.swatch.style.background = state.color ?? 'transparent';
    this.swatch.classList.toggle('empty', !state.color);
    this.colorText.textContent = state.color ? state.color.toUpperCase() : t('Noch keine Farbe');
    this.colorHint.textContent = this.picking
      ? t('Klick ins Bild auf eine Stelle des Hintergrunds.')
      : state.color ? '' : t('Vitool hat keinen einfarbigen Hintergrund erkannt. Wähle die Farbe im Bild.');
    this.colorHint.hidden = !this.colorHint.textContent;
    this.pickButton.classList.toggle('primary', this.picking);
    const media = state.background === 'image' || state.background === 'video';
    this.colorRow.hidden = state.background !== 'color';
    this.mediaRow.hidden = !media;
    this.transparentRow.hidden = state.background !== 'transparent';
    this.backgroundName.textContent = state.backgroundPath ? state.backgroundPath.split(/[\\/]/).pop() : '';
    this.backgroundName.title = state.backgroundPath ?? '';
    this.formatHint.textContent = state.transparentFormat === 'webm'
      ? t('WebM bleibt klein und läuft im Browser und in OBS.')
      : t('MOV mit ProRes 4444 ist groß, aber für Schnittprogramme wie Premiere oder DaVinci Resolve gedacht.');
    this.viewButtons.render();
    this.backgroundButtons.render();
    this.formatButtons.render();
    this.onChange?.();
  }

  mediaKind(filePath) {
    return IMAGE_EXTENSIONS.includes(filePath.split('.').pop().toLowerCase()) ? 'image' : 'video';
  }

  async pickBackground() {
    const filePath = await window.vitool.invoke('dialog:pickBackground');
    if (filePath) this.setBackground(filePath);
    else this.renderPanel();
  }

  setBackground(filePath) {
    this.state.backgroundPath = filePath;
    this.state.background = this.mediaKind(filePath);
    const url = fileUrl(filePath);
    if (this.state.background === 'image') {
      this.backgroundVideo.removeAttribute('src');
      this.backgroundImage.src = url;
    } else {
      this.backgroundVideo.src = url;
    }
    this.renderPanel();
    this.render();
  }

  setPicking(on) {
    this.picking = on;
    this.canvas.classList.toggle('picking', on);
    if (on && this.state.view === 'original') {
      this.state.view = 'result';
      this.render();
    }
    this.renderPanel();
  }

  load(media) {
    this.media = media;
    this.state.color = null;
    this.setPicking(false);
    this.renderPanel();
  }

  setActive(active) {
    const { media } = this;
    const was = this.active;
    this.active = active;
    this.controlsRow.hidden = !active;
    if (!active) {
      this.canvas.hidden = true;
      if (was) {
        this.video.controls = true;
        this.player.root.classList.remove('crop-stage');
        this.player.root.style.width = '';
        this.player.root.style.aspectRatio = '';
        this.player.root.style.maxHeight = '';
        this.backgroundVideo.pause();
      }
      return;
    }
    this.video.controls = false;
    this.player.root.classList.toggle('crop-stage', Boolean(media));
    this.player.root.style.width = media ? `${(PREVIEW_HEIGHT * media.width) / media.height}px` : '';
    this.player.root.style.aspectRatio = media ? `${media.width} / ${media.height}` : '';
    this.player.root.style.maxHeight = `${PREVIEW_HEIGHT}px`;
    if (!this.state.color && this.video.readyState >= 2) this.detectColor();
    this.renderPlayback();
    this.render();
  }

  ready() {
    const { state } = this;
    if (!state.color) return false;
    if (state.background === 'image' || state.background === 'video') return Boolean(state.backgroundPath);
    return true;
  }

  options() {
    const { state } = this;
    return {
      color: state.color,
      similarity: state.similarity,
      blend: state.blend,
      despill: state.despill,
      background: state.background,
      backgroundColor: state.backgroundColor,
      backgroundPath: state.backgroundPath,
      transparentFormat: state.transparentFormat,
    };
  }

  renderPlayback() {
    if (!this.media) return;
    this.playButton.textContent = this.video.paused ? t('Abspielen') : t('Pause');
    if (document.activeElement !== this.seek) this.seek.value = String(Math.round((this.video.currentTime / this.media.duration) * 1000));
    this.timeLabel.textContent = `${formatTime(this.video.currentTime)} / ${formatTime(this.media.duration)}`;
  }

  watch() {
    if (this.frameRequest !== null) return;
    const step = () => {
      this.frameRequest = null;
      if (!this.active || this.video.paused) return;
      this.render();
      this.frameRequest = this.video.requestVideoFrameCallback(step);
    };
    this.frameRequest = this.video.requestVideoFrameCallback(step);
  }

  syncBackground() {
    const background = this.backgroundVideo;
    if (!background.getAttribute('src') || !background.duration) return;
    const target = this.video.currentTime % background.duration;
    if (Math.abs(background.currentTime - target) > 0.3) background.currentTime = target;
  }

  // Liest das aktuelle Bild in kleiner Auflösung. Gibt null zurück, solange noch keins da ist.
  grabFrame() {
    const { video } = this;
    if (video.readyState < 2 || !video.videoWidth) return null;
    const width = Math.min(WORK_WIDTH, video.videoWidth);
    const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
    this.work.width = width;
    this.work.height = height;
    const context = this.work.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  // Ist der Rand überwiegend kräftig grün oder blau, ist es ein Greenscreen. Die Farbe kommt dann
  // aus dem ganzen Bild, als Median. So zählen abgedunkelte Ecken und Schatten kaum.
  detectColor(force = false) {
    const frame = this.grabFrame();
    if (!frame) return;
    const { width, height, data } = frame;
    const groupOf = (r, g, b) => {
      if (g > r * 1.25 && g > b * 1.15 && g > 40) return 'green';
      if (b > r * 1.25 && b > g * 1.1 && b > 40) return 'blue';
      return null;
    };
    const border = { green: 0, blue: 0, total: 0 };
    const samples = { green: [[], [], []], blue: [[], [], []] };
    const borderX = Math.max(2, Math.round(width * BORDER));
    const borderY = Math.max(2, Math.round(height * BORDER));
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const index = (y * width + x) * 4;
        const rgb = [data[index], data[index + 1], data[index + 2]];
        const group = groupOf(...rgb);
        if (x < borderX || x >= width - borderX || y < borderY || y >= height - borderY) {
          border.total += 1;
          if (group) border[group] += 1;
        }
        if (group) rgb.forEach((value, channel) => samples[group][channel].push(value));
      }
    }
    const best = border.green >= border.blue ? 'green' : 'blue';
    if (border[best] > border.total * 0.3) {
      const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
      this.state.color = `#${samples[best].map((values) => toHex(median(values))).join('')}`;
      this.tune(frame);
    } else if (force) {
      this.state.color = null;
    }
    this.renderPanel();
    this.render();
  }

  // Wie weit die Farbe greifen darf, hängt vom Bild ab: Ein blasser Hintergrund liegt farblich
  // nah an Haut und Kleidung, ein kräftiger weit weg. Die Abstände aller Punkte zur Schlüsselfarbe
  // zerfallen in zwei Gruppen (Hintergrund und Vordergrund). Die Grenze dazwischen findet Otsu.
  tune(frame) {
    const { data } = frame;
    const [ku, kv] = uvOf(...parseHex(this.state.color));
    const counts = new Array(TUNE_BINS).fill(0);
    let total = 0;
    for (let index = 0; index < data.length; index += 8) {
      const [u, v] = uvOf(data[index], data[index + 1], data[index + 2]);
      const distance = Math.hypot(u - ku, v - kv) / (255 * Math.SQRT2);
      counts[Math.min(TUNE_BINS - 1, Math.floor((distance / TUNE_RANGE) * TUNE_BINS))] += 1;
      total += 1;
    }
    let sumAll = 0;
    counts.forEach((count, bin) => { sumAll += count * bin; });
    let weight = 0;
    let sum = 0;
    let bestScore = 0;
    let bestBin = -1;
    for (let bin = 0; bin < TUNE_BINS; bin += 1) {
      weight += counts[bin];
      sum += counts[bin] * bin;
      const rest = total - weight;
      if (!weight || !rest) continue;
      const score = weight * rest * ((sum / weight) - ((sumAll - sum) / rest)) ** 2;
      if (score > bestScore) {
        bestScore = score;
        bestBin = bin;
      }
    }
    if (bestBin < 0) return;
    const limit = ((bestBin + 1) / TUNE_BINS) * TUNE_RANGE;
    this.setValue('similarity', Math.min(0.3, Math.max(0.01, limit * 0.8)));
    this.setValue('blend', Math.min(0.2, Math.max(0.01, limit * 0.5)));
  }

  setValue(key, value) {
    const rounded = Math.round(value * 1000) / 1000;
    this.state[key] = rounded;
    this[key].input.value = String(rounded);
    this[key].value.textContent = PERCENT(rounded);
  }

  onCanvasClick(event) {
    if (!this.picking) {
      if (this.video.paused) this.video.play();
      else this.video.pause();
      return;
    }
    const frame = this.grabFrame();
    if (!frame) return;
    const box = this.canvas.getBoundingClientRect();
    const centerX = Math.round(((event.clientX - box.left) / box.width) * frame.width);
    const centerY = Math.round(((event.clientY - box.top) / box.height) * frame.height);
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = centerY - 2; y <= centerY + 2; y += 1) {
      for (let x = centerX - 2; x <= centerX + 2; x += 1) {
        if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
        const index = (y * frame.width + x) * 4;
        sum[0] += frame.data[index];
        sum[1] += frame.data[index + 1];
        sum[2] += frame.data[index + 2];
        count += 1;
      }
    }
    if (!count) return;
    this.state.color = `#${sum.map((value) => toHex(value / count)).join('')}`;
    this.tune(frame);
    this.setPicking(false);
    this.render();
  }

  render() {
    if (!this.active || !this.media) return;
    const { state } = this;
    const showOriginal = state.view === 'original' || !state.color;
    this.canvas.hidden = showOriginal && !this.picking;
    if (this.canvas.hidden) return;
    const frame = this.grabFrame();
    if (!frame) return;
    const { width, height } = frame;

    if (!showOriginal) this.keyFrame(frame);
    this.keyed.width = width;
    this.keyed.height = height;
    this.keyed.getContext('2d').putImageData(frame, 0, 0);

    this.canvas.width = width;
    this.canvas.height = height;
    const context = this.canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    this.canvas.classList.toggle('checker', state.view === 'result' && state.background === 'transparent');
    if (state.view === 'result' && !showOriginal) this.drawBackground(context, width, height);
    context.drawImage(this.keyed, 0, 0);
  }

  drawBackground(context, width, height) {
    const { state } = this;
    if (state.background === 'color') {
      context.fillStyle = state.backgroundColor;
      context.fillRect(0, 0, width, height);
    } else if (state.background === 'image' && this.backgroundImage.naturalWidth) {
      const image = this.backgroundImage;
      context.drawImage(image, ...coverRect(image.naturalWidth, image.naturalHeight, width, height));
    } else if (state.background === 'video' && this.backgroundVideo.videoWidth) {
      const video = this.backgroundVideo;
      context.drawImage(video, ...coverRect(video.videoWidth, video.videoHeight, width, height));
    }
  }

  // chromakey: Abstand der Farbanteile zur Schlüsselfarbe, über 3 × 3 Punkte gemittelt.
  // despill: zieht den Überschuss an Grün (oder Blau) gegenüber den anderen Farben ab.
  keyFrame(frame) {
    const { width, height, data } = frame;
    const { state } = this;
    const [kr, kg, kb] = parseHex(state.color);
    const [ku, kv] = uvOf(kr, kg, kb);
    const blue = kb > kg;
    const count = width * height;
    const diff = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 4;
      const [u, v] = uvOf(data[offset], data[offset + 1], data[offset + 2]);
      const du = Math.round(u) - Math.round(ku);
      const dv = Math.round(v) - Math.round(kv);
      diff[index] = Math.sqrt((du * du + dv * dv) / (255 * 255 * 2));
    }
    // 3 × 3 Mittel in zwei Durchgängen.
    const rows = new Float32Array(count);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const left = diff[row + Math.max(0, x - 1)];
        const right = diff[row + Math.min(width - 1, x + 1)];
        rows[row + x] = left + diff[row + x] + right;
      }
    }
    const { similarity, blend, despill, view } = state;
    for (let y = 0; y < height; y += 1) {
      const up = Math.max(0, y - 1) * width;
      const down = Math.min(height - 1, y + 1) * width;
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const average = (rows[up + x] + rows[row + x] + rows[down + x]) / 9;
        const alpha = blend > 0.0001
          ? Math.min(1, Math.max(0, (average - similarity) / blend))
          : average > similarity ? 1 : 0;
        const offset = (row + x) * 4;
        if (view === 'mask') {
          const shade = alpha * 255;
          data[offset] = shade;
          data[offset + 1] = shade;
          data[offset + 2] = shade;
          data[offset + 3] = 255;
          continue;
        }
        if (despill) {
          const r = data[offset];
          const g = data[offset + 1];
          const b = data[offset + 2];
          if (blue) data[offset + 2] = b - Math.max(0, b - (r * 0.5 + g * 0.5));
          else data[offset + 1] = g - Math.max(0, g - (r * 0.5 + b * 0.5));
        }
        data[offset + 3] = alpha * 255;
      }
    }
  }
}
