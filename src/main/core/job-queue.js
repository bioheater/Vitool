// Warteschlange für alle Bereiche. Ein Modul übergibt nur Titel und run(job)-Funktion.
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { CanceledError } = require('./process-runner');
const { toGermanMessage } = require('./error-messages');

const MAX_PARALLEL = 2;
const UPDATE_INTERVAL_MS = 150;

class JobQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    this.updateTimer = null;
  }

  list() {
    return this.jobs.map(({ run: _run, controller: _controller, ...job }) => job);
  }

  add({ title, kind, run }) {
    const job = {
      id: randomUUID(),
      title,
      kind,
      status: 'queued',
      progress: null,
      detail: 'Wartet …',
      error: null,
      resultPath: null,
      run,
      controller: null,
    };
    this.jobs.push(job);
    this.notify(true);
    this.startNext();
    return job.id;
  }

  cancel(id) {
    const job = this.jobs.find((entry) => entry.id === id);
    if (!job) return;
    if (job.status === 'queued') {
      this.finish(job, 'canceled', 'Abgebrochen');
    } else if (job.status === 'running') {
      job.detail = 'Wird abgebrochen …';
      job.controller.abort();
      this.notify(true);
    }
  }

  clearFinished() {
    this.jobs = this.jobs.filter((job) => job.status === 'queued' || job.status === 'running');
    this.notify(true);
  }

  startNext() {
    const running = this.jobs.filter((job) => job.status === 'running').length;
    const next = this.jobs.find((job) => job.status === 'queued');
    if (next && running < MAX_PARALLEL) {
      this.execute(next);
      this.startNext();
    }
  }

  async execute(job) {
    job.status = 'running';
    job.detail = 'Startet …';
    job.controller = new AbortController();
    this.notify(true);

    const handle = {
      signal: job.controller.signal,
      update: ({ progress, detail }) => {
        if (progress !== undefined) job.progress = progress;
        if (detail !== undefined) job.detail = detail;
        this.notify();
      },
    };

    try {
      job.resultPath = (await job.run(handle)) ?? null;
      job.progress = 100;
      this.finish(job, 'done', 'Fertig');
    } catch (error) {
      if (error instanceof CanceledError) {
        this.finish(job, 'canceled', 'Abgebrochen');
      } else {
        job.error = toGermanMessage(error);
        this.finish(job, 'failed', 'Fehlgeschlagen');
      }
    }
    this.startNext();
  }

  finish(job, status, detail) {
    job.status = status;
    job.detail = detail;
    this.notify(true);
  }

  notify(immediately = false) {
    if (immediately) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
      this.emit('change', this.list());
    } else if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null;
        this.emit('change', this.list());
      }, UPDATE_INTERVAL_MS);
    }
  }
}

module.exports = { JobQueue };
