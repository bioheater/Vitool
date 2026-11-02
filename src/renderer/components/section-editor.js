// Zeitleiste plus Abschnittsliste. Wird von den Bereichen Download und Schneiden genutzt.
import { el } from '../utils/dom.js';
import { formatTime, parseTime } from '../utils/time.js';
import { Timeline } from './timeline.js';
import { frameButtons } from './video-controls.js';
import { t } from '../utils/i18n.js';

export class SectionEditor {
  constructor({ video, onMessage, createRange, single = false }) {
    this.video = video;
    this.onMessage = onMessage;
    this.createRange = createRange;
    this.duration = 0;
    this.ranges = [];
    this.active = 0;
    this.merge = false;
    this.looping = false;
    this.loopEnabled = true;

    const timelineRoot = el('div', { class: 'timeline' });
    this.timeline = new Timeline(timelineRoot, {
      onChange: (index, range, edge) => this.applyDrag(index, range, edge),
      onSelect: (index) => this.select(index),
      onSeek: (time) => this.seek(time),
    });

    this.list = el('ul', { class: 'section-list' });
    this.mergeSeparate = el('input', { type: 'radio', onchange: () => { this.merge = false; } });
    this.mergeTogether = el('input', { type: 'radio', onchange: () => { this.merge = true; } });
    this.mergeField = el('fieldset', { class: 'choices', hidden: true },
      el('legend', {}, t('Mehrere Abschnitte speichern')),
      el('label', {}, this.mergeSeparate, t('Als einzelne Dateien')),
      el('label', {}, this.mergeTogether, t('Zu einer Datei zusammenfügen')),
    );
    // Jede Instanz braucht eine eigene Gruppe, sonst beeinflussen sich die Seiten gegenseitig.
    this.mergeSeparate.name = this.mergeTogether.name = `merge-${Math.random()}`;

    this.root = el('div', { class: 'stack' },
      el('div', { class: 'marker-row' }, ...frameButtons(video)),
      timelineRoot,
      this.list,
      single ? null : el('div', {}, el('button', { class: 'button', onclick: () => this.add() }, t('Abschnitt hinzufügen'))),
      this.mergeField,
    );

    video.addEventListener('timeupdate', () => {
      this.keepInsideRange();
      this.timeline.setPlayhead(video.currentTime);
    });
    video.addEventListener('loadedmetadata', () => {
      const range = this.activeRange();
      if (range) video.currentTime = range.start;
    });
    video.addEventListener('play', () => this.startLoop());
    video.addEventListener('ended', () => {
      const range = this.activeRange();
      if (!range) return;
      video.currentTime = range.start;
      video.play();
    });
  }

  activeRange() {
    return this.loopEnabled ? this.ranges[this.active] : undefined;
  }

  // Beim Abspielen läuft das Video als Schleife durch den aktiven Abschnitt.
  startLoop() {
    const range = this.activeRange();
    if (range && this.video.currentTime < range.start) this.video.currentTime = range.start;
    if (this.looping) return;
    this.looping = true;

    const check = () => {
      if (this.video.paused) {
        this.looping = false;
        return;
      }
      this.keepInsideRange();
      this.timeline.setPlayhead(this.video.currentTime);
      requestAnimationFrame(check);
    };
    check();
  }

  keepInsideRange() {
    const range = this.activeRange();
    if (!range || this.video.paused || this.video.currentTime < range.end) return;
    this.video.currentTime = range.start;
  }

  load(duration) {
    this.duration = duration;
    this.ranges = [];
    this.active = 0;
    this.merge = false;
    this.timeline.setDuration(duration);
    this.timeline.setPlayhead(0);
  }

  ensureRange() {
    if (this.ranges.length === 0) this.add();
  }

  add() {
    this.ranges.push(this.createRange(this.duration, this.ranges.at(-1)));
    this.active = this.ranges.length - 1;
    this.render();
  }

  remove(index) {
    this.ranges.splice(index, 1);
    this.active = Math.min(this.active, this.ranges.length - 1);
    if (this.ranges.length === 0) this.add();
    else this.render();
  }

  // Setzt Start oder Ende des aktiven Abschnitts, zum Beispiel auf die aktuelle Player-Zeit.
  setEdge(edge, time) {
    const range = this.ranges[this.active];
    const next = { ...range, [edge]: Math.round(time * 10) / 10 };
    if (next.start >= next.end) {
      this.onMessage(edge === 'start'
        ? t('Der Start muss vor dem Ende liegen.')
        : t('Das Ende muss nach dem Start liegen.'));
      return;
    }
    this.onMessage('');
    this.ranges[this.active] = next;
    this.render();
  }

  seek(time) {
    this.timeline.setPlayhead(time);
    if (this.video.getAttribute('src') && this.video.readyState > 0) this.video.currentTime = time;
  }

  select(index) {
    this.active = index;
    this.timeline.update(this.ranges, this.active);
    [...this.list.children].forEach((row, rowIndex) => row.classList.toggle('active', rowIndex === index));
  }

  applyDrag(index, range, edge) {
    this.video.pause();
    this.ranges[index] = range;
    this.seek(range[edge]);
    const row = this.list.children[index];
    const [startInput, endInput] = row.querySelectorAll('input');
    startInput.value = formatTime(range.start, true);
    endInput.value = formatTime(range.end, true);
    row.querySelector('.section-length').textContent = formatTime(range.end - range.start, true);
    this.timeline.update(this.ranges, this.active);
  }

  commitTime(index, edge, input) {
    const range = this.ranges[index];
    const value = parseTime(input.value);
    const next = { ...range, [edge]: value };
    if (value === null || next.start >= next.end || next.end > this.duration) {
      input.value = formatTime(range[edge], true);
      this.onMessage(t('Diese Zeit passt nicht. Nutze zum Beispiel 01:30 und bleibe innerhalb der Videolänge.'));
      return;
    }
    this.onMessage('');
    this.ranges[index] = next;
    this.active = index;
    this.seek(value);
    this.render();
  }

  timeInput(index, edge, label) {
    const input = el('input', {
      class: 'input time',
      value: formatTime(this.ranges[index][edge], true),
      'aria-label': t('{label} Abschnitt {number}', { label, number: index + 1 }),
      onfocus: () => this.select(index),
      onchange: () => this.commitTime(index, edge, input),
      onkeydown: (event) => {
        if (event.key === 'Enter') input.blur();
      },
    });
    return input;
  }

  render() {
    this.timeline.update(this.ranges, this.active);
    this.list.replaceChildren(...this.ranges.map((range, index) =>
      el('li', { class: `section-row ${index === this.active ? 'active' : ''}` },
        el('span', { class: 'section-name' }, t('Abschnitt {number}', { number: index + 1 })),
        this.timeInput(index, 'start', 'Start'),
        el('span', { class: 'muted' }, 'bis'),
        this.timeInput(index, 'end', t('Ende')),
        el('span', { class: 'muted section-length' }, formatTime(range.end - range.start, true)),
        this.ranges.length > 1
          ? el('button', { class: 'button small', onclick: () => this.remove(index) }, t('Entfernen'))
          : null,
      )));

    this.mergeField.hidden = this.ranges.length < 2;
    this.mergeSeparate.checked = !this.merge;
    this.mergeTogether.checked = this.merge;
  }
}
