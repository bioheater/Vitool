// Zensier-Editor: Felder auf dem Video platzieren. Jede Änderung setzt einen Keyframe.
import { el } from '../utils/dom.js';
import { formatTime } from '../utils/time.js';
import { Timeline } from './timeline.js';
import { frameButtons } from './video-controls.js';
import { t } from '../utils/i18n.js';

const MIN_SIZE = 0.02;
const NEW_FIELD_SIZE = 0.3;
const PREVIEW_HEIGHT = 380;
const MAX_FEATHER = 30; // Muss zum Export passen (censor.js), gilt für ein 720p-Bild.
const CORNERS = ['nw', 'ne', 'sw', 'se'];

const SHAPES = [{ value: 'rect', text: t('Rechteck') }, { value: 'ellipse', text: t('Oval') }];
const EFFECTS = [{ value: 'blur', text: 'Blur' }, { value: 'pixel', text: t('Verpixeln') }, { value: 'black', text: t('Schwarz') }];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function boxAt(keyframes, time) {
  const next = keyframes.findIndex((keyframe) => keyframe.time >= time);
  if (next === -1) return keyframes.at(-1);
  if (next === 0) return keyframes[0];
  const before = keyframes[next - 1];
  const after = keyframes[next];
  const part = (time - before.time) / (after.time - before.time);
  const mix = (key) => before[key] + (after[key] - before[key]) * part;
  return { x: mix('x'), y: mix('y'), w: mix('w'), h: mix('h'), strength: mix('strength') };
}

// Nur die Werte eines Keyframes, ohne seine Zeit: als Grundlage für einen neuen Keyframe.
function valuesAt(keyframes, time) {
  const { x, y, w, h, strength } = boxAt(keyframes, time);
  return { x, y, w, h, strength };
}

export class CensorEditor {
  constructor({ player, onChange }) {
    this.player = player;
    this.video = player.video;
    this.onChange = onChange;
    this.media = null;
    this.fields = [];
    this.active = 0;
    this.fieldNodes = [];
    this.watching = false;

    this.layer = el('div', { class: 'censor-layer', hidden: true });
    player.root.append(this.layer);

    // Die Seite darf die Zeitleiste direkt unter das Video setzen.
    const timelineRoot = el('div', { class: 'timeline' });
    this.timelineRoot = timelineRoot;
    // Die grüne Leiste sieht aus wie beim Schneiden, bestimmt aber nur, wann das Feld zu sehen ist.
    this.timelineHint = el('p', { class: 'muted timeline-hint', hidden: true });
    this.timeline = new Timeline(timelineRoot, {
      onChange: (_index, range, edge) => {
        Object.assign(this.current(), range);
        this.video.pause();
        this.video.currentTime = range[edge];
        this.renderTimeline();
        this.renderPanel();
        this.renderFields();
      },
      onSelect: () => {},
      onSeek: (time) => {
        this.video.currentTime = time;
      },
    });

    this.fieldList = el('div', { class: 'segments censor-tabs', role: 'group', 'aria-label': t('Felder') });
    this.controls = el('div', { class: 'stack' });
    this.hint = el('p', { class: 'muted' }, t('Füge ein Feld hinzu, ziehe es an die richtige Stelle und ändere die Größe an den Ecken. Spule weiter und verschiebe das Feld erneut oder ändere die Stärke. Bei jeder Änderung entsteht automatisch ein Keyframe, dazwischen ändert sich das Feld gleichmäßig.'));
    this.warning = el('p', { class: 'muted', hidden: true }, t('Für wirklich sensible Inhalte wie Namen, Nummern oder Texte ist Schwarz am sichersten.'));

    this.root = el('section', { class: 'card stack' },
      el('div', { class: 'marker-row' },
        el('button', { class: 'button', onclick: () => this.addField() }, t('Feld hinzufügen')),
        this.fieldList,
        el('span', { class: 'spacer' }),
        ...frameButtons(this.video)),
      this.hint,
      timelineRoot,
      this.controls,
      this.warning,
    );

    ['timeupdate', 'seeked', 'loadedmetadata'].forEach((name) => {
      this.video.addEventListener(name, () => this.onTime());
    });
    this.video.addEventListener('play', () => this.watchPlayback());
  }

  current() {
    return this.fields[this.active];
  }

  time() {
    return this.video.currentTime;
  }

  frameTime() {
    return 0.5 / (this.media?.fps || 30);
  }

  load(media) {
    this.media = media;
    this.fields = [];
    this.active = 0;
    this.timeline.setDuration(media.duration);
    this.timeline.setPlayhead(0);
    this.render();
  }

  setActive(active) {
    const { media } = this;
    this.layer.hidden = !active;
    this.player.root.classList.toggle('crop-stage', Boolean(active && media));
    this.player.root.style.width = active && media ? `${(PREVIEW_HEIGHT * media.width) / media.height}px` : '';
    this.player.root.style.aspectRatio = active && media ? `${media.width} / ${media.height}` : '';
    this.player.root.style.maxHeight = active ? `${PREVIEW_HEIGHT}px` : '';
    if (!active) return;
    this.render();
    this.timeline.setPlayhead(this.time());
  }

  addField() {
    const time = this.time();
    const start = (1 - NEW_FIELD_SIZE) / 2;
    this.fields.push({
      shape: 'rect',
      effect: 'blur',
      feather: 0,
      start: 0,
      end: this.media.duration,
      keyframes: [{ time, x: start, y: start, w: NEW_FIELD_SIZE, h: NEW_FIELD_SIZE, strength: 50 }],
    });
    this.active = this.fields.length - 1;
    this.render();
  }

  removeField() {
    this.fields.splice(this.active, 1);
    this.active = Math.max(0, this.active - 1);
    this.render();
  }

  select(index) {
    this.active = index;
    this.render();
  }

  // Liegt an der aktuellen Stelle schon ein Keyframe, wird er angepasst, sonst entsteht ein neuer.
  // Ein neuer Keyframe übernimmt alle Werte dieser Stelle, damit sich nur das Geänderte bewegt.
  setBox(patch) {
    const field = this.current();
    const time = this.time();
    const existing = field.keyframes.find((keyframe) => Math.abs(keyframe.time - time) <= this.frameTime());
    if (existing) Object.assign(existing, patch);
    else field.keyframes.push({ time, ...valuesAt(field.keyframes, time), ...patch });
    field.keyframes.sort((a, b) => a.time - b.time);
    this.positionFields();
    this.renderTimeline();
    this.renderKeyframeInfo();
  }

  deleteKeyframe() {
    const field = this.current();
    if (field.keyframes.length < 2) return;
    const time = this.time();
    const nearest = field.keyframes.reduce((best, keyframe) =>
      (Math.abs(keyframe.time - time) < Math.abs(best.time - time) ? keyframe : best));
    field.keyframes.splice(field.keyframes.indexOf(nearest), 1);
    this.render();
  }

  jumpKeyframe(direction) {
    const time = this.time();
    const margin = this.frameTime();
    const list = this.current().keyframes;
    const target = direction > 0
      ? list.find((keyframe) => keyframe.time > time + margin)
      : list.findLast((keyframe) => keyframe.time < time - margin);
    if (target) {
      this.video.pause();
      this.video.currentTime = target.time;
    }
  }

  setRangeEdge(edge) {
    const field = this.current();
    const next = { start: field.start, end: field.end, [edge]: this.time() };
    if (next.start >= next.end) return;
    Object.assign(field, next);
    this.render();
  }

  startDrag(event, index, corner) {
    event.preventDefault();
    event.stopPropagation();
    if (index !== this.active) this.select(index);
    this.video.pause();

    const stage = this.layer.getBoundingClientRect();
    const { clientX, clientY } = event;
    // Eine Kopie, denn das Ziehen verändert den Keyframe, von dem aus gerechnet wird.
    const origin = valuesAt(this.current().keyframes, this.time());

    const move = (moveEvent) => {
      const dx = (moveEvent.clientX - clientX) / stage.width;
      const dy = (moveEvent.clientY - clientY) / stage.height;
      this.setBox(corner ? resized(origin, corner, dx, dy) : moved(origin, dx, dy));
    };
    // Die Felder werden beim Auswählen neu aufgebaut, deshalb hört das Fenster auf die Maus.
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  watchPlayback() {
    if (this.watching) return;
    this.watching = true;
    const step = () => {
      if (this.video.paused) {
        this.watching = false;
        return;
      }
      this.onTime();
      requestAnimationFrame(step);
    };
    step();
  }

  onTime() {
    if (this.layer.hidden || !this.media) return;
    this.timeline.setPlayhead(this.time());
    this.positionFields();
    this.renderKeyframeInfo();
    this.renderStrength();
  }

  // Der Regler zeigt die Stärke an der aktuellen Stelle, außer man zieht gerade daran.
  renderStrength() {
    const field = this.current();
    if (!field || !this.strengthInput || document.activeElement === this.strengthInput) return;
    const strength = Math.round(valuesAt(field.keyframes, this.time()).strength);
    this.strengthInput.value = strength;
    this.strengthValue.textContent = `${strength} %`;
  }

  render() {
    this.renderTabs();
    this.renderFields();
    this.renderTimeline();
    this.renderPanel();
  }

  renderTabs() {
    this.fieldList.hidden = this.fields.length === 0;
    this.fieldList.replaceChildren(...this.fields.map((_field, index) => {
      const button = el('button', { class: `segment ${index === this.active ? 'active' : ''}`, onclick: () => this.select(index) }, t('Feld {number}', { number: index + 1 }));
      button.setAttribute('aria-pressed', String(index === this.active));
      return button;
    }));
    this.hint.hidden = this.fields.length > 0;
  }

  renderTimeline() {
    const field = this.current();
    this.timelineHint.hidden = !field;
    this.timelineHint.textContent = field
      ? t('Grüne Leiste: Zeitraum, in dem Feld {number} zu sehen ist. Exportiert wird immer das ganze Video, zum Kürzen nutze vorher „Schneiden“.', { number: this.active + 1 })
      : '';
    if (!this.media) return;
    this.timeline.update(field ? [{ start: field.start, end: field.end }] : [], 0);
    this.timeline.setMarkers(field ? field.keyframes.map((keyframe) => keyframe.time) : []);
  }

  renderFields() {
    this.fieldNodes = this.fields.map((field, index) => {
      // Effekt unten, Rahmen und Griffe darüber. So bleiben Rahmen und Griffe scharf, und der Blur
      // sieht nur das Video: Läge der blaue Rahmen darunter, würde er mit verwischt.
      const effect = el('div', { class: `censor-effect ${field.effect}` });
      if (field.effect === 'pixel') effect.append(el('canvas', { class: 'censor-mosaic' }));
      const frame = el('div', { class: 'censor-frame' });
      const node = el('div', { class: `censor-field ${field.shape} ${index === this.active ? 'active' : ''}` }, effect, frame);
      node.addEventListener('pointerdown', (event) => this.startDrag(event, index, null));
      if (index === this.active) {
        CORNERS.forEach((corner) => {
          const handle = el('span', { class: `censor-handle ${corner}` });
          handle.addEventListener('pointerdown', (event) => this.startDrag(event, index, corner));
          frame.append(handle);
        });
      }
      return node;
    });
    this.layer.replaceChildren(...this.fieldNodes);
    this.positionFields();
  }

  positionFields() {
    const time = this.time();
    const stageHeight = this.layer.clientHeight || PREVIEW_HEIGHT;
    this.fields.forEach((field, index) => {
      const node = this.fieldNodes[index];
      const box = boxAt(field.keyframes, time);
      node.style.left = `${box.x * 100}%`;
      node.style.top = `${box.y * 100}%`;
      node.style.width = `${box.w * 100}%`;
      node.style.height = `${box.h * 100}%`;
      node.hidden = time < field.start || time > field.end;
      const effect = node.firstChild;
      const radius = (box.strength / 100) * 50 * (stageHeight / 720);
      effect.style.backdropFilter = field.effect === 'blur' ? `blur(${radius.toFixed(1)}px)` : '';
      const reach = this.featherPreview(effect, field, box, stageHeight);
      if (field.effect === 'pixel' && !node.hidden) this.drawMosaic(effect.querySelector('canvas'), field, box, reach);
    });
  }

  // Wie im Export: Der weiche Übergang reicht etwa zwei Sigma nach innen und nach außen über den Rand.
  featherPreview(effect, field, box, stageHeight) {
    const sigma = ((field.feather ?? 0) / 100) * MAX_FEATHER * (stageHeight / 720);
    const reach = sigma > 0.2 ? 2 * sigma : 0;
    effect.style.inset = `${-reach}px`;
    effect.classList.toggle('soft', reach > 0);
    if (reach === 0) {
      effect.style.maskImage = '';
      effect.style.maskComposite = '';
      return 0;
    }
    const fade = 2 * reach;
    if (field.shape === 'ellipse') {
      const stageWidth = this.layer.clientWidth || stageHeight;
      const radius = Math.min(box.w * stageWidth, box.h * stageHeight) / 2 + reach;
      const inner = Math.max(0, 100 - (fade / radius) * 100);
      effect.style.maskImage = `radial-gradient(closest-side, #000 ${inner.toFixed(1)}%, transparent 100%)`;
      effect.style.maskComposite = '';
    } else {
      // Beide Verläufe müssen gelten, sonst blieben die Seiten hart und nur die Ecken weich.
      const edge = (direction) => `linear-gradient(${direction}, transparent 0, #000 ${fade}px, #000 calc(100% - ${fade}px), transparent 100%)`;
      effect.style.maskImage = `${edge('to right')}, ${edge('to bottom')}`;
      effect.style.maskComposite = 'intersect';
    }
    return reach;
  }

  // Der Ausschnitt wird winzig gezeichnet und danach ohne Glättung groß dargestellt.
  // Mit weicher Kante ist die Effektfläche etwas größer als das Feld, der Ausschnitt wächst mit.
  drawMosaic(canvas, field, box, reach = 0) {
    const { videoWidth, videoHeight } = this.video;
    if (!videoWidth) return;
    const stageHeight = this.layer.clientHeight || PREVIEW_HEIGHT;
    const grow = (reach / stageHeight) * videoHeight;
    const block = Math.max(2, (box.strength / 100) * 60 * (videoHeight / 720));
    const sourceWidth = box.w * videoWidth + 2 * grow;
    const sourceHeight = box.h * videoHeight + 2 * grow;
    canvas.width = Math.max(1, Math.round(sourceWidth / block));
    canvas.height = Math.max(1, Math.round(sourceHeight / block));
    canvas.getContext('2d').drawImage(this.video, box.x * videoWidth - grow, box.y * videoHeight - grow, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  }

  renderKeyframeInfo() {
    if (!this.keyframeInfo || !this.current()) return;
    const { keyframes } = this.current();
    const here = keyframes.some((keyframe) => Math.abs(keyframe.time - this.time()) <= this.frameTime());
    const count = keyframes.length === 1 ? t('1 Keyframe') : t('{count} Keyframes', { count: keyframes.length });
    this.keyframeInfo.textContent = `${count}${here ? t(' · an dieser Stelle gesetzt') : ''}`;
  }

  choice(label, choices, value, onSelect) {
    const buttons = choices.map((choice) => {
      const button = el('button', {
        class: `segment ${choice.value === value ? 'active' : ''}`,
        onclick: () => onSelect(choice.value),
      }, choice.text);
      button.setAttribute('aria-pressed', String(choice.value === value));
      return button;
    });
    return el('div', { class: 'segments', role: 'group', 'aria-label': label }, ...buttons);
  }

  renderPanel() {
    const field = this.current();
    this.warning.hidden = !field || field.effect === 'black';
    this.onChange(this.fields.length);
    if (!field) {
      this.controls.replaceChildren();
      return;
    }

    // Die Stärke gehört wie Position und Größe zum Keyframe und ändert sich dazwischen gleichmäßig.
    const current = Math.round(valuesAt(field.keyframes, this.time()).strength);
    const strengthValue = el('span', { class: 'muted' }, `${current} %`);
    const strength = el('input', {
      type: 'range',
      min: 1,
      max: 100,
      value: current,
      'aria-label': t('Stärke'),
      title: t('Setzt an dieser Stelle einen Keyframe'),
      oninput: (event) => {
        const value = Number(event.target.value);
        strengthValue.textContent = `${value} %`;
        this.video.pause();
        this.setBox({ strength: value });
      },
    });
    this.strengthInput = strength;
    this.strengthValue = strengthValue;

    const featherValue = el('span', { class: 'muted' }, `${field.feather ?? 0} %`);
    const feather = el('input', {
      type: 'range',
      min: 0,
      max: 100,
      value: field.feather ?? 0,
      'aria-label': t('Weiche Kante'),
      oninput: (event) => {
        field.feather = Number(event.target.value);
        featherValue.textContent = `${field.feather} %`;
        this.positionFields();
      },
    });

    this.keyframeInfo = el('span', { class: 'muted' });
    this.controls.replaceChildren(
      el('div', { class: 'option-row' },
        this.choice(t('Form'), SHAPES, field.shape, (value) => {
          field.shape = value;
          this.render();
        }),
        this.choice(t('Effekt'), EFFECTS, field.effect, (value) => {
          field.effect = value;
          this.render();
        }),
      ),
      field.effect === 'black' ? null : el('label', { class: 'crop-control' }, el('span', { class: 'muted slider-label' }, t('Stärke')), strength, strengthValue),
      el('label', { class: 'crop-control' }, el('span', { class: 'muted slider-label' }, t('Weiche Kante')), feather, featherValue),
      el('div', { class: 'marker-row' },
        el('button', { class: 'button small', onclick: () => this.jumpKeyframe(-1) }, t('Vorheriger Keyframe')),
        el('button', { class: 'button small', onclick: () => this.jumpKeyframe(1) }, t('Nächster Keyframe')),
        el('button', { class: 'button small', onclick: () => this.deleteKeyframe() }, t('Keyframe löschen')),
        this.keyframeInfo,
      ),
      el('div', { class: 'marker-row' },
        el('span', { class: 'muted' }, t('Sichtbar von {start} bis {end}', { start: formatTime(field.start, true), end: formatTime(field.end, true) })),
        el('button', { class: 'button small', onclick: () => this.setRangeEdge('start') }, t('Beginnt hier')),
        el('button', { class: 'button small', onclick: () => this.setRangeEdge('end') }, t('Endet hier')),
        el('button', { class: 'button small', onclick: () => this.removeField() }, t('Feld entfernen')),
      ),
    );
    this.renderKeyframeInfo();
  }
}

function moved(origin, dx, dy) {
  return {
    x: clamp(origin.x + dx, 0, 1 - origin.w),
    y: clamp(origin.y + dy, 0, 1 - origin.h),
    w: origin.w,
    h: origin.h,
  };
}

function resized(origin, corner, dx, dy) {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.w;
  let bottom = origin.y + origin.h;

  if (corner.includes('w')) left = clamp(left + dx, 0, right - MIN_SIZE);
  else right = clamp(right + dx, left + MIN_SIZE, 1);
  if (corner.includes('n')) top = clamp(top + dy, 0, bottom - MIN_SIZE);
  else bottom = clamp(bottom + dy, top + MIN_SIZE, 1);

  return { x: left, y: top, w: right - left, h: bottom - top };
}
