// Zensier-Editor: Felder auf dem Video platzieren. Jede Änderung setzt einen Keyframe.
import { el } from '../utils/dom.js';
import { formatTime } from '../utils/time.js';
import { Timeline } from './timeline.js';
import { frameButtons } from './video-controls.js';

const MIN_SIZE = 0.02;
const NEW_FIELD_SIZE = 0.3;
const PREVIEW_HEIGHT = 380;
const CORNERS = ['nw', 'ne', 'sw', 'se'];

const SHAPES = [{ value: 'rect', text: 'Rechteck' }, { value: 'ellipse', text: 'Oval' }];
const EFFECTS = [{ value: 'blur', text: 'Blur' }, { value: 'pixel', text: 'Verpixeln' }, { value: 'black', text: 'Schwarz' }];

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
  return { x: mix('x'), y: mix('y'), w: mix('w'), h: mix('h') };
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

    this.fieldList = el('div', { class: 'segments censor-tabs', role: 'group', 'aria-label': 'Felder' });
    this.controls = el('div', { class: 'stack' });
    this.hint = el('p', { class: 'muted' }, 'Füge ein Feld hinzu, ziehe es an die richtige Stelle und ändere die Größe an den Ecken. Spule weiter und verschiebe das Feld erneut. Bei jeder Änderung entsteht automatisch ein Keyframe, dazwischen bewegt sich das Feld gleichmäßig.');
    this.warning = el('p', { class: 'muted', hidden: true }, 'Für wirklich sensible Inhalte wie Namen, Nummern oder Texte ist Schwarz am sichersten.');

    this.root = el('section', { class: 'card stack' },
      el('div', { class: 'marker-row' },
        el('button', { class: 'button', onclick: () => this.addField() }, 'Feld hinzufügen'),
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
      strength: 50,
      start: 0,
      end: this.media.duration,
      keyframes: [{ time, x: start, y: start, w: NEW_FIELD_SIZE, h: NEW_FIELD_SIZE }],
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
  setBox(box) {
    const field = this.current();
    const time = this.time();
    const existing = field.keyframes.find((keyframe) => Math.abs(keyframe.time - time) <= this.frameTime());
    if (existing) Object.assign(existing, box);
    else field.keyframes.push({ time, ...box });
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
    const origin = { ...boxAt(this.current().keyframes, this.time()) };

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
      const button = el('button', { class: `segment ${index === this.active ? 'active' : ''}`, onclick: () => this.select(index) }, `Feld ${index + 1}`);
      button.setAttribute('aria-pressed', String(index === this.active));
      return button;
    }));
    this.hint.hidden = this.fields.length > 0;
  }

  renderTimeline() {
    const field = this.current();
    if (!this.media) return;
    this.timeline.update(field ? [{ start: field.start, end: field.end }] : [], 0);
    this.timeline.setMarkers(field ? field.keyframes.map((keyframe) => keyframe.time) : []);
  }

  renderFields() {
    this.fieldNodes = this.fields.map((field, index) => {
      const node = el('div', { class: `censor-field ${field.shape} ${field.effect} ${index === this.active ? 'active' : ''}` });
      if (field.effect === 'pixel') node.append(el('canvas', { class: 'censor-mosaic' }));
      node.addEventListener('pointerdown', (event) => this.startDrag(event, index, null));
      if (index === this.active) {
        CORNERS.forEach((corner) => {
          const handle = el('span', { class: `censor-handle ${corner}` });
          handle.addEventListener('pointerdown', (event) => this.startDrag(event, index, corner));
          node.append(handle);
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
      const radius = (field.strength / 100) * 50 * (stageHeight / 720);
      node.style.backdropFilter = field.effect === 'blur' ? `blur(${radius.toFixed(1)}px)` : '';
      if (field.effect === 'pixel' && !node.hidden) this.drawMosaic(node.querySelector('canvas'), field, box);
    });
  }

  // Der Ausschnitt wird winzig gezeichnet und danach ohne Glättung groß dargestellt.
  drawMosaic(canvas, field, box) {
    const { videoWidth, videoHeight } = this.video;
    if (!videoWidth) return;
    const block = Math.max(2, (field.strength / 100) * 60 * (videoHeight / 720));
    const sourceWidth = box.w * videoWidth;
    const sourceHeight = box.h * videoHeight;
    canvas.width = Math.max(1, Math.round(sourceWidth / block));
    canvas.height = Math.max(1, Math.round(sourceHeight / block));
    canvas.getContext('2d').drawImage(this.video, box.x * videoWidth, box.y * videoHeight, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  }

  renderKeyframeInfo() {
    if (!this.keyframeInfo || !this.current()) return;
    const { keyframes } = this.current();
    const here = keyframes.some((keyframe) => Math.abs(keyframe.time - this.time()) <= this.frameTime());
    this.keyframeInfo.textContent = `${keyframes.length} ${keyframes.length === 1 ? 'Keyframe' : 'Keyframes'}${here ? ' · an dieser Stelle gesetzt' : ''}`;
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

    const strengthValue = el('span', { class: 'muted' }, `${field.strength} %`);
    const strength = el('input', {
      type: 'range',
      min: 1,
      max: 100,
      value: field.strength,
      'aria-label': 'Stärke',
      oninput: (event) => {
        field.strength = Number(event.target.value);
        strengthValue.textContent = `${field.strength} %`;
        this.positionFields();
      },
    });

    this.keyframeInfo = el('span', { class: 'muted' });
    this.controls.replaceChildren(
      el('div', { class: 'option-row' },
        this.choice('Form', SHAPES, field.shape, (value) => {
          field.shape = value;
          this.render();
        }),
        this.choice('Effekt', EFFECTS, field.effect, (value) => {
          field.effect = value;
          this.render();
        }),
      ),
      field.effect === 'black' ? null : el('label', { class: 'crop-control' }, el('span', { class: 'muted' }, 'Stärke'), strength, strengthValue),
      el('div', { class: 'marker-row' },
        el('button', { class: 'button small', onclick: () => this.jumpKeyframe(-1) }, 'Vorheriger Keyframe'),
        el('button', { class: 'button small', onclick: () => this.jumpKeyframe(1) }, 'Nächster Keyframe'),
        el('button', { class: 'button small', onclick: () => this.deleteKeyframe() }, 'Keyframe löschen'),
        this.keyframeInfo,
      ),
      el('div', { class: 'marker-row' },
        el('span', { class: 'muted' }, `Sichtbar von ${formatTime(field.start, true)} bis ${formatTime(field.end, true)}`),
        el('button', { class: 'button small', onclick: () => this.setRangeEdge('start') }, 'Beginnt hier'),
        el('button', { class: 'button small', onclick: () => this.setRangeEdge('end') }, 'Endet hier'),
        el('button', { class: 'button small', onclick: () => this.removeField() }, 'Feld entfernen'),
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
