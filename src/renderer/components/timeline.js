// Zeitleiste mit mehreren Abschnitten. Der aktive Abschnitt hat zwei Griffe für Start und Ende.
// Wird auch im Bereich Schneiden verwendet.
import { el } from '../utils/dom.js';
import { formatTime } from '../utils/time.js';
import { t } from '../utils/i18n.js';

const MIN_LENGTH = 1;
const KEY_STEP = 1;
const TICK_COUNT = 5;

export class Timeline {
  constructor(root, { onChange, onSelect, onSeek }) {
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.onSeek = onSeek;
    this.duration = 0;
    this.ranges = [];
    this.active = 0;

    this.rangeLayer = el('div', { class: 'tl-ranges' });
    this.markerLayer = el('div', { class: 'tl-markers' });
    this.playhead = el('div', { class: 'tl-playhead' });
    this.startHandle = this.createHandle('start', t('Start des Abschnitts'));
    this.endHandle = this.createHandle('end', t('Ende des Abschnitts'));
    this.track = el('div', { class: 'tl-track' },
      this.rangeLayer, this.markerLayer, this.playhead, this.startHandle, this.endHandle);
    this.ticks = el('div', { class: 'tl-ticks' });
    root.append(this.track, this.ticks);

    this.track.addEventListener('pointerdown', (event) => {
      if (event.target === this.startHandle || event.target === this.endHandle) return;
      if (event.target.dataset.index !== undefined) {
        this.onSelect(Number(event.target.dataset.index));
      }
      this.startScrub(event);
    });
  }

  // Klicken springt an die Stelle, weiteres Ziehen fährt den Cursor durchs Video.
  startScrub(event) {
    event.preventDefault();
    this.onSeek(this.timeAt(event.clientX));

    const move = (moveEvent) => this.onSeek(this.timeAt(moveEvent.clientX));
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  createHandle(edge, label) {
    const handle = el('div', {
      class: `tl-handle ${edge}`,
      role: 'slider',
      tabIndex: 0,
      'aria-label': label,
    });

    handle.addEventListener('pointerdown', (event) => {
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
      handle.focus();
    });
    handle.addEventListener('pointermove', (event) => {
      if (handle.hasPointerCapture(event.pointerId)) this.moveEdge(edge, this.timeAt(event.clientX));
    });
    handle.addEventListener('keydown', (event) => {
      const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (!direction) return;
      event.preventDefault();
      const range = this.ranges[this.active];
      this.moveEdge(edge, range[edge] + direction * KEY_STEP);
    });
    return handle;
  }

  timeAt(clientX) {
    const box = this.track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return Math.round(ratio * this.duration * 10) / 10;
  }

  moveEdge(edge, time) {
    const range = this.ranges[this.active];
    const value = edge === 'start'
      ? Math.max(0, Math.min(time, range.end - MIN_LENGTH))
      : Math.min(this.duration, Math.max(time, range.start + MIN_LENGTH));
    this.onChange(this.active, { ...range, [edge]: value }, edge);
  }

  setDuration(duration) {
    this.duration = duration;
    const labels = Array.from({ length: TICK_COUNT }, (_, index) =>
      el('span', {}, formatTime((duration * index) / (TICK_COUNT - 1))));
    this.ticks.replaceChildren(...labels);
  }

  update(ranges, active) {
    this.ranges = ranges;
    this.active = active;
    const percent = (time) => `${(time / this.duration) * 100}%`;

    this.rangeLayer.replaceChildren(...ranges.map((range, index) => {
      const block = el('div', { class: `tl-range ${index === active ? 'active' : ''}` });
      block.dataset.index = index;
      block.style.left = percent(range.start);
      block.style.width = `${((range.end - range.start) / this.duration) * 100}%`;
      return block;
    }));

    const current = ranges[active];
    [[this.startHandle, 'start'], [this.endHandle, 'end']].forEach(([handle, edge]) => {
      handle.hidden = !current;
      if (!current) return;
      handle.style.left = percent(current[edge]);
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', String(this.duration));
      handle.setAttribute('aria-valuenow', String(current[edge]));
      handle.setAttribute('aria-valuetext', formatTime(current[edge], true));
    });
  }

  setMarkers(times) {
    this.markerLayer.replaceChildren(...times.map((time) => {
      const marker = el('span', { class: 'tl-marker' });
      marker.style.left = `${(time / this.duration) * 100}%`;
      return marker;
    }));
  }

  setPlayhead(time) {
    if (!this.duration) return;
    this.playhead.style.left = `${(time / this.duration) * 100}%`;
  }
}
