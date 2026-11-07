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
const ROTATE_SNAP = 15;
const VISIBLE_PART = 0.03;

const SHAPES = [{ value: 'rect', text: t('Rechteck') }, { value: 'ellipse', text: t('Oval') }];
const EFFECTS = [{ value: 'blur', text: 'Blur' }, { value: 'pixel', text: t('Verpixeln') }, { value: 'black', text: t('Schwarz') }];
const MOTIONS = [{ value: 'glide', text: t('Gleiten') }, { value: 'jump', text: t('Springen') }];

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
  const mix = (key) => (before[key] ?? 0) + ((after[key] ?? 0) - (before[key] ?? 0)) * part;
  return { x: mix('x'), y: mix('y'), w: mix('w'), h: mix('h'), strength: mix('strength'), angle: mix('angle') };
}

// Nur die Werte eines Keyframes, ohne seine Zeit: als Grundlage für einen neuen Keyframe.
function valuesAt(keyframes, time) {
  const { x, y, w, h, strength, angle = 0 } = boxAt(keyframes, time);
  return { x, y, w, h, strength, angle };
}

// Ein Feld kann mehrmals erscheinen und wieder verschwinden. Jeder Zeitraum ist ein eigener Abschnitt.
function rangeAt(field, time) {
  return field.ranges.findIndex((range) => time >= range.start && time <= range.end);
}

const visibleAt = (field, time) => rangeAt(field, time) >= 0;

export class CensorEditor {
  constructor({ player, onChange }) {
    this.player = player;
    this.video = player.video;
    this.onChange = onChange;
    this.media = null;
    this.fields = [];
    this.active = 0;
    this.activeRange = 0;
    this.motion = 'glide';
    this.fieldNodes = [];
    this.watching = false;

    this.layer = el('div', { class: 'censor-layer', hidden: true });
    player.root.append(this.layer);

    // Die Seite darf die Zeitleiste direkt unter das Video setzen.
    const timelineRoot = el('div', { class: 'timeline' });
    this.timelineRoot = timelineRoot;
    // Die Leiste sieht aus wie beim Schneiden, bestimmt aber nur, wann das Feld zu sehen ist.
    this.timelineHint = el('p', { class: 'muted timeline-hint', hidden: true });
    this.timeline = new Timeline(timelineRoot, {
      // Ein Abschnitt darf nicht in den Nachbarn hineinragen.
      onChange: (index, range, edge) => {
        const { ranges } = this.current();
        const start = Math.max(range.start, ranges[index - 1]?.end ?? 0);
        const end = Math.min(range.end, ranges[index + 1]?.start ?? this.media.duration);
        if (end <= start) return;
        ranges[index] = { start, end };
        this.activeRange = index;
        this.video.pause();
        this.video.currentTime = ranges[index][edge];
        this.renderTimeline();
        this.renderPanel();
        this.renderFields();
      },
      onSelect: (index) => {
        this.activeRange = index;
        this.renderTimeline();
      },
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
      ranges: [{ start: 0, end: this.media.duration }],
      keyframes: [{ time, x: start, y: start, w: NEW_FIELD_SIZE, h: NEW_FIELD_SIZE, strength: 50, angle: 0 }],
    });
    this.active = this.fields.length - 1;
    this.activeRange = 0;
    this.render();
  }

  removeField() {
    this.fields.splice(this.active, 1);
    this.active = Math.max(0, this.active - 1);
    this.activeRange = 0;
    this.render();
  }

  select(index) {
    this.active = index;
    this.activeRange = Math.max(0, rangeAt(this.current(), this.time()));
    this.render();
  }

  // Liegt an der aktuellen Stelle schon ein Keyframe, wird er angepasst, sonst entsteht ein neuer.
  // Ein neuer Keyframe übernimmt alle Werte dieser Stelle, damit sich nur das Geänderte bewegt.
  // Bei "Springen" hält ein zusätzlicher Keyframe ein Bild vorher die alte Lage fest. So gleitet das Feld
  // nicht über die ganze Zeit seit dem letzten Keyframe, sondern wechselt erst hier.
  setBox(patch) {
    const field = this.current();
    const time = this.time();
    const margin = this.frameTime();
    const existing = field.keyframes.find((keyframe) => Math.abs(keyframe.time - time) <= margin);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      const values = valuesAt(field.keyframes, time);
      const holdTime = time - 2 * margin;
      const earlier = field.keyframes.some((keyframe) => keyframe.time < holdTime - margin);
      const holdTaken = field.keyframes.some((keyframe) => Math.abs(keyframe.time - holdTime) <= margin);
      if (this.motion === 'jump' && earlier && !holdTaken) field.keyframes.push({ time: holdTime, ...valuesAt(field.keyframes, holdTime) });
      field.keyframes.push({ time, ...values, ...patch });
    }
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

  // Im sichtbaren Abschnitt rückt "Zeigen ab hier" seinen Anfang hierher. Außerhalb beginnt hier ein neuer
  // Abschnitt, der bis zum nächsten reicht und mit ihm verschmilzt, oder bis zum Ende des Videos.
  showFromHere() {
    const field = this.current();
    const time = this.time();
    const inside = rangeAt(field, time);
    if (inside >= 0) {
      if (field.ranges[inside].end - time < 2 * this.frameTime()) return;
      field.ranges[inside].start = time;
    } else {
      const next = field.ranges.find((range) => range.start > time);
      if (next) next.start = time;
      else field.ranges.push({ start: time, end: this.media.duration });
      field.ranges.sort((a, b) => a.start - b.start);
    }
    this.activeRange = rangeAt(field, time);
    this.render();
  }

  // Beendet den Abschnitt hier. Danach lässt "Zeigen ab hier" das Feld später wieder erscheinen.
  hideFromHere() {
    const field = this.current();
    const time = this.time();
    const inside = rangeAt(field, time);
    if (inside < 0) return;
    if (time - field.ranges[inside].start < 2 * this.frameTime()) field.ranges.splice(inside, 1);
    else field.ranges[inside].end = time;
    this.activeRange = Math.max(0, Math.min(inside, field.ranges.length - 1));
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
      if (!corner) this.setBox(moved(origin, dx, dy));
      else if (Math.abs(origin.angle) < 0.01) this.setBox(resized(origin, corner, dx, dy));
      else this.setBox(resizedRotated(origin, corner, dx * stage.width, dy * stage.height, stage));
    };
    this.followPointer(move);
  }

  // Der Winkel folgt der Maus um die Feldmitte. Mit Umschalt rastet er in 15-Grad-Schritten ein.
  startRotate(event) {
    event.preventDefault();
    event.stopPropagation();
    this.video.pause();
    const node = this.fieldNodes[this.active];
    const box = node.getBoundingClientRect();
    const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const pointerAngle = (pointer) => (Math.atan2(pointer.clientY - center.y, pointer.clientX - center.x) * 180) / Math.PI;
    const startAngle = pointerAngle(event);
    const origin = valuesAt(this.current().keyframes, this.time()).angle;

    this.followPointer((moveEvent) => {
      let angle = normalizeAngle(origin + pointerAngle(moveEvent) - startAngle);
      if (moveEvent.shiftKey) angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
      this.setBox({ angle });
      this.renderAngle();
    });
  }

  followPointer(move) {
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
    this.renderAngle();
    this.renderRangeButtons();
  }

  renderAngle() {
    const field = this.current();
    if (!field || !this.angleInput || document.activeElement === this.angleInput) return;
    const angle = Math.round(valuesAt(field.keyframes, this.time()).angle);
    this.angleInput.value = angle;
    this.angleValue.textContent = `${angle}°`;
  }

  // Welcher Knopf gerade etwas bewirkt, hängt davon ab, ob das Feld hier zu sehen ist.
  renderRangeButtons() {
    const field = this.current();
    if (!field || !this.hideButton) return;
    this.hideButton.disabled = !visibleAt(field, this.time());
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
      ? t('Die Leisten zeigen, wann Feld {number} zu sehen ist. Exportiert wird immer das ganze Video, zum Kürzen nutze vorher „Schneiden“.', { number: this.active + 1 })
      : '';
    if (!this.media) return;
    if (field) this.activeRange = Math.min(this.activeRange, Math.max(0, field.ranges.length - 1));
    this.timeline.update(field ? field.ranges : [], this.activeRange);
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
        const rotate = el('span', { class: 'censor-rotate', title: t('Drehen (mit Umschalt in 15-Grad-Schritten)') });
        rotate.addEventListener('pointerdown', (event) => this.startRotate(event));
        frame.append(rotate);
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
      node.style.transform = Math.abs(box.angle) < 0.01 ? '' : `rotate(${box.angle}deg)`;
      node.hidden = !visibleAt(field, time);
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
    const context = canvas.getContext('2d');
    if (Math.abs(box.angle) < 0.01) {
      context.drawImage(this.video, box.x * videoWidth - grow, box.y * videoHeight - grow, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      return;
    }
    // Das gedrehte Feld dreht seinen Inhalt mit. Deshalb wird das Bild hier zurückgedreht gezeichnet.
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((-box.angle * Math.PI) / 180);
    context.scale(canvas.width / sourceWidth, canvas.height / sourceHeight);
    context.drawImage(this.video, -(box.x + box.w / 2) * videoWidth, -(box.y + box.h / 2) * videoHeight);
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

    const angleNow = Math.round(valuesAt(field.keyframes, this.time()).angle);
    const angleValue = el('span', { class: 'muted' }, `${angleNow}°`);
    const angle = el('input', {
      type: 'range',
      min: -180,
      max: 180,
      value: angleNow,
      'aria-label': t('Drehung'),
      title: t('Setzt an dieser Stelle einen Keyframe. Doppelklick: gerade'),
      oninput: (event) => {
        const value = Number(event.target.value);
        angleValue.textContent = `${value}°`;
        this.video.pause();
        this.setBox({ angle: value });
      },
      ondblclick: () => {
        angle.value = 0;
        angleValue.textContent = '0°';
        this.setBox({ angle: 0 });
      },
    });
    this.angleInput = angle;
    this.angleValue = angleValue;

    this.hideButton = el('button', {
      class: 'button small',
      title: t('Das Feld verschwindet ab dieser Stelle. Mit „Zeigen ab hier“ erscheint es später wieder.'),
      onclick: () => this.hideFromHere(),
    }, t('Ausblenden ab hier'));
    const ranges = field.ranges.length
      ? field.ranges.map((range) => `${formatTime(range.start, true)}–${formatTime(range.end, true)}`).join(', ')
      : t('nie');

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
      el('label', { class: 'crop-control' }, el('span', { class: 'muted slider-label' }, t('Drehung')), angle, angleValue),
      el('div', { class: 'marker-row' },
        el('button', { class: 'button small', onclick: () => this.jumpKeyframe(-1) }, t('Vorheriger Keyframe')),
        el('button', { class: 'button small', onclick: () => this.jumpKeyframe(1) }, t('Nächster Keyframe')),
        el('button', { class: 'button small', onclick: () => this.deleteKeyframe() }, t('Keyframe löschen')),
        this.keyframeInfo,
      ),
      // Gleiten: Das Feld bewegt sich gleichmäßig vom letzten Keyframe zum neuen.
      // Springen: Es bleibt bis kurz vor dem neuen Keyframe, wo es war, und wechselt dann sofort.
      el('div', { class: 'marker-row' },
        el('span', { class: 'muted slider-label' }, t('Änderung')),
        this.choice(t('Änderung'), MOTIONS, this.motion, (value) => {
          this.motion = value;
          this.renderPanel();
        }),
        el('span', { class: 'muted' }, this.motion === 'jump'
          ? t('Das Feld bleibt bis hierher, wo es war, und wechselt dann sofort.')
          : t('Das Feld bewegt sich gleichmäßig vom letzten Keyframe hierher.')),
      ),
      el('div', { class: 'marker-row' },
        el('span', { class: 'muted' }, t('Sichtbar: {ranges}', { ranges })),
        el('button', {
          class: 'button small',
          title: t('Das Feld ist ab dieser Stelle zu sehen, bis zum nächsten Abschnitt oder zum Ende.'),
          onclick: () => this.showFromHere(),
        }, t('Zeigen ab hier')),
        this.hideButton,
        el('button', { class: 'button small', onclick: () => this.removeField() }, t('Feld entfernen')),
      ),
    );
    this.renderKeyframeInfo();
    this.renderRangeButtons();
  }
}

function normalizeAngle(angle) {
  return ((((angle + 180) % 360) + 360) % 360) - 180;
}

// Ein Feld darf über den Bildrand hinaus, etwa für etwas, das gerade ins Bild kommt.
// Ein schmaler Streifen bleibt immer sichtbar, damit man es wieder greifen kann.
function moved(origin, dx, dy) {
  return {
    x: clamp(origin.x + dx, VISIBLE_PART - origin.w, 1 - VISIBLE_PART),
    y: clamp(origin.y + dy, VISIBLE_PART - origin.h, 1 - VISIBLE_PART),
    w: origin.w,
    h: origin.h,
  };
}

function resized(origin, corner, dx, dy) {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.w;
  let bottom = origin.y + origin.h;

  if (corner.includes('w')) left = clamp(left + dx, -1, Math.min(right - MIN_SIZE, 1 - VISIBLE_PART));
  else right = clamp(right + dx, Math.max(left + MIN_SIZE, VISIBLE_PART), 2);
  if (corner.includes('n')) top = clamp(top + dy, -1, Math.min(bottom - MIN_SIZE, 1 - VISIBLE_PART));
  else bottom = clamp(bottom + dy, Math.max(top + MIN_SIZE, VISIBLE_PART), 2);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

// Gedreht: Die Mausbewegung wird ins Feld zurückgedreht, die gegenüberliegende Ecke bleibt stehen.
// Gerechnet wird in Pixeln, weil Breite und Höhe sonst verschieden skaliert wären.
function resizedRotated(origin, corner, dx, dy, stage) {
  const radians = (origin.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const turn = (a, b) => ({ x: a * cos - b * sin, y: a * sin + b * cos });
  const width = origin.w * stage.width;
  const height = origin.h * stage.height;
  const sideX = corner.includes('e') ? 1 : -1;
  const sideY = corner.includes('s') ? 1 : -1;
  const nextWidth = Math.max(MIN_SIZE * stage.width, width + sideX * (dx * cos + dy * sin));
  const nextHeight = Math.max(MIN_SIZE * stage.height, height + sideY * (-dx * sin + dy * cos));

  const center = { x: (origin.x + origin.w / 2) * stage.width, y: (origin.y + origin.h / 2) * stage.height };
  const fixed = turn((-sideX * width) / 2, (-sideY * height) / 2);
  const reach = turn((sideX * nextWidth) / 2, (sideY * nextHeight) / 2);
  const nextCenter = { x: center.x + fixed.x + reach.x, y: center.y + fixed.y + reach.y };
  return {
    x: (nextCenter.x - nextWidth / 2) / stage.width,
    y: (nextCenter.y - nextHeight / 2) / stage.height,
    w: nextWidth / stage.width,
    h: nextHeight / stage.height,
  };
}
