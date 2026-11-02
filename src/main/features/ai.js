// Bereich KI-Maske: freiwilliges Zusatzpaket mit SAM 2.1.
// Nichts davon wird ohne ausdrücklichen Klick heruntergeladen, alles liegt im Ordner "ki".
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { app } = require('electron');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { run, CanceledError } = require('../core/process-runner');
const { runFfmpeg, probeMedia } = require('../core/ffmpeg');
const { moveFile } = require('../core/files');
const { exec, findPython, findGpu, folderSizeGb, downloadFile, pythonScript } = require('../core/python-tools');
const { effectFilter, even } = require('./censor');
const { t } = require('../core/i18n');

const MODEL_BASE = 'https://dl.fbaipublicfiles.com/segment_anything_2/092824';
const SAM2_PACKAGE = 'https://github.com/facebookresearch/sam2/archive/refs/heads/main.zip';
const MODELS = [
  { id: 'tiny', file: 'sam2.1_hiera_tiny.pt', label: 'Tiny', sizeMb: 149, text: t('Am schnellsten, etwas ungenauer') },
  { id: 'small', file: 'sam2.1_hiera_small.pt', label: 'Small', sizeMb: 176, text: t('Guter Mittelweg'), recommended: true },
  { id: 'base_plus', file: 'sam2.1_hiera_base_plus.pt', label: 'Base+', sizeMb: 309, text: t('Genauer, braucht mehr Grafikspeicher') },
  { id: 'large', file: 'sam2.1_hiera_large.pt', label: 'Large', sizeMb: 856, text: t('Am genauesten, am langsamsten') },
];
const INSTALL_SIZE_GB = 4.5;
const MAX_FPS = 30;
const MAX_FRAME_HEIGHT = 720;
const REFERENCE_HEIGHT = 720; // Die Reglerwerte gelten für ein 720p-Bild.
const EDGE_LIMIT = 20;
const EDGE_SPREAD = 1.4;

class WorkerClient {
  constructor(pythonPath, script) {
    this.pending = null;
    this.buffer = '';
    this.child = spawn(pythonPath, ['-u', script], {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True' },
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.errors = `${this.errors ?? ''}${chunk}`.slice(-3000);
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.on('close', () => {
      const pending = this.pending;
      this.pending = null;
      this.closed = true;
      pending?.reject(pending.canceled ? new CanceledError() : new Error(`KI-Dienst beendet: ${this.errors ?? ''}`));
    });
    this.ready = new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    lines.filter((line) => line.startsWith('{')).forEach((line) => this.onMessage(JSON.parse(line)));
  }

  onMessage(message) {
    if (message.progress !== undefined) {
      this.pending?.onProgress?.(message.progress);
      return;
    }
    const pending = this.pending;
    this.pending = null;
    if (message.error === 'memory') {
      pending?.reject(new UserError(t('Der Grafikspeicher reicht nicht. Wähle einen kürzeren Abschnitt oder ein kleineres Modell.')));
    } else if (message.error) {
      pending?.reject(new Error(message.error));
    } else {
      pending?.resolve(message.result ?? message);
    }
  }

  request(command, onProgress) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, onProgress };
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  kill(canceled = false) {
    if (this.pending) this.pending.canceled = canceled;
    this.child.kill();
  }
}

function register({ ipcMain, queue, store, tools, send }) {
  const root = path.join(app.getPath('userData'), 'ki');
  const envDir = path.join(root, 'umgebung');
  const modelDir = path.join(root, 'modelle');
  const envPython = path.join(envDir, 'Scripts', 'python.exe');
  const markerFile = path.join(root, 'installiert.txt');
  let worker = null;
  let session = null;

  const modelPath = (model) => path.join(modelDir, model.file);
  const findModel = (id) => {
    const model = MODELS.find((entry) => entry.id === id);
    if (!model) throw new UserError(t('Dieses Modell gibt es nicht.'));
    return model;
  };

  // Python, Grafikkarte und Ordnergröße brauchen Sekunden. Sie werden im Hintergrund ermittelt,
  // damit die Seite sofort erscheint, und danach als Ergänzung nachgeschickt.
  const slowInfo = { checked: false, python: null, gpu: null, usedGb: null };
  let slowCheck = null;

  function refreshSlowInfo() {
    slowCheck ??= (async () => {
      const [python, gpu, usedGb] = await Promise.all([
        findPython(),
        findGpu(),
        fsSync.existsSync(markerFile) ? folderSizeGb(root) : 0,
      ]);
      Object.assign(slowInfo, {
        checked: true,
        python,
        gpu,
        usedGb: Number(usedGb.toFixed(1)),
      });
      slowCheck = null;
      send('ai:statusChanged');
    })();
    return slowCheck;
  }

  async function status() {
    const installed = fsSync.existsSync(markerFile);
    const disk = await fs.statfs(app.getPath('userData'));
    const saved = store.get('settings').aiModel ?? 'small';
    const downloaded = MODELS.filter((model) => fsSync.existsSync(modelPath(model)));
    return {
      installed,
      checked: slowInfo.checked,
      python: slowInfo.python,
      gpu: slowInfo.gpu,
      installSizeGb: INSTALL_SIZE_GB,
      freeGb: Math.floor((disk.bavail * disk.bsize) / 1024 ** 3),
      usedGb: installed ? slowInfo.usedGb : 0,
      // Ist das gewählte Modell nicht vorhanden, gilt das erste heruntergeladene.
      selected: downloaded.some((model) => model.id === saved) ? saved : downloaded[0]?.id ?? saved,
      models: MODELS.map((model) => ({ ...model, downloaded: downloaded.includes(model) })),
    };
  }

  async function runPip(args, job, detail, progress) {
    job.update({ detail, progress });
    await run(envPython, ['-m', 'pip', 'install', '--disable-pip-version-check', ...args], {
      signal: job.signal,
      env: { SAM2_BUILD_CUDA: '0' },
    });
  }

  async function runInstall(job) {
    const python = await findPython();
    if (!python) throw new UserError(t('Python wurde nicht gefunden.'));
    const hasNvidia = Boolean(await exec('nvidia-smi', ['-L']));
    const torchIndex = `https://download.pytorch.org/whl/${hasNvidia ? 'cu128' : 'cpu'}`;

    await fs.mkdir(root, { recursive: true });
    job.update({ detail: t('Richtet Umgebung ein'), progress: 2 });
    await run(python.path, ['-m', 'venv', envDir], { signal: job.signal });
    await runPip(['torch', 'torchvision', '--index-url', torchIndex], job, t('Lädt PyTorch, das dauert einige Minuten'), 10);
    await runPip([SAM2_PACKAGE], job, t('Installiert SAM 2.1'), 80);
    await fs.writeFile(markerFile, new Date().toISOString(), 'utf8');
  }

  async function runDownload(model, job) {
    await fs.mkdir(modelDir, { recursive: true });
    let loaded = 0;
    await downloadFile(`${MODEL_BASE}/${model.file}`, modelPath(model), {
      signal: job.signal,
      onProgress: (bytes, total) => {
        loaded += bytes;
        job.update({ progress: total ? (loaded / total) * 100 : null, detail: t('Lädt Modell {name}', { name: model.label }) });
      },
    });
  }

  function stopWorker() {
    worker?.kill();
    worker = null;
  }

  async function getWorker() {
    if (worker && !worker.closed) return worker;
    const script = pythonScript('sam2_worker.py');
    worker = new WorkerClient(envPython, script);
    await worker.ready;
    return worker;
  }

  async function closeSession() {
    if (session) await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
    session = null;
  }

  async function runPrepare(options, media, job) {
    await closeSession();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-ki-'));
    const frames = path.join(dir, 'bilder');
    await fs.mkdir(frames);
    const fps = Math.round(Math.min(media.fps, MAX_FPS) * 1000) / 1000;
    const { start, end } = options;

    job.update({ detail: t('Bereitet Bilder vor'), progress: 0 });
    await runFfmpeg(tools.path('ffmpeg'), [
      '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', media.path,
      '-vf', `fps=${fps},scale=-2:'min(${MAX_FRAME_HEIGHT},ih)'`,
      '-q:v', '2', '-start_number', '0', path.join(frames, '%05d.jpg'),
    ], {
      duration: end - start,
      signal: job.signal,
      onProgress: (part) => job.update({ progress: part * 40, detail: t('Bereitet Bilder vor') }),
    });

    job.update({ detail: t('Lädt KI-Modell'), progress: 45 });
    const model = findModel(options.model);
    const client = await getWorker();
    const cancel = () => client.kill(true);
    job.signal.addEventListener('abort', cancel, { once: true });
    const result = await client.request({ type: 'load', model: model.id, checkpoint: modelPath(model), frames });
    job.signal.removeEventListener('abort', cancel);

    session = { dir, media, fps, start, end, frames: result.frames, device: result.device, tracked: false };
    return null;
  }

  async function runTrack(job) {
    const masks = path.join(session.dir, 'masken');
    const previews = path.join(session.dir, 'vorschau');
    const client = requireWorker();
    const cancel = () => client.kill(true);
    job.signal.addEventListener('abort', cancel, { once: true });
    await client.request({ type: 'track', masks, previews }, (part) => {
      job.update({ progress: part * 100, detail: t('Verfolgt Objekt') });
    });
    job.signal.removeEventListener('abort', cancel);
    session.tracked = true;
  }

  // Weichzeichnen und neu begrenzen verschiebt den Rand gleichmäßig um die gewünschte Strecke.
  function maskChain(options, video) {
    const scale = video.height / REFERENCE_HEIGHT;
    const expand = (options.expand ?? 0) * scale;
    const feather = (options.feather ?? 0) * scale;
    // Im Vollbereich rechnen: Sonst liegt Weiß bei 235 und die Grenzwerte treffen nicht mehr.
    const chain = [`scale=${video.width}:${video.height}:flags=bilinear:in_range=full:out_range=full`, 'format=gray'];

    if (expand !== 0) {
      const limit = expand > 0 ? EDGE_LIMIT : 255 - EDGE_LIMIT;
      chain.push(`gblur=sigma=${Math.max(0.5, Math.abs(expand) / EDGE_SPREAD).toFixed(2)}`);
      chain.push(`lut=y='if(gt(val,${limit}),255,0)'`);
    }
    if (feather > 0) chain.push(`gblur=sigma=${feather.toFixed(2)}`);
    if (options.target === 'background') chain.push('negate');
    return chain.join(',');
  }

  async function runExport(options, job) {
    const { media, fps, start, end, dir } = session;
    const video = { width: even(media.width), height: even(media.height) };
    const name = path.parse(media.name).name;
    const masks = ['-framerate', String(fps), '-start_number', '0', '-i', path.join(dir, 'masken', '%05d.png')];
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));

    try {
      // Schwarzweiß-Maske für Schnittprogramme, ohne Ton.
      if (options.effect === 'matte') {
        const prores = options.matteFormat === 'prores';
        const ext = prores ? 'mov' : 'mp4';
        const output = path.join(temp, `ergebnis.${ext}`);
        const codec = prores
          ? ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le']
          : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
        const pixelFormat = prores ? 'yuv422p10le' : 'yuv420p';
        await runFfmpeg(tools.path('ffmpeg'), [
          ...masks,
          '-vf', `${maskChain(options, video)},scale=out_range=limited,format=${pixelFormat}`,
          ...codec, '-an', output,
        ], {
          duration: end - start,
          signal: job.signal,
          onProgress: (part) => job.update({ progress: part * 100, detail: t('Erstellt Alpha-Maske') }),
        });
        return await moveFile(output, options.folder, `${name} (${t('Alpha-Maske')}).${ext}`);
      }

      if (options.effect === 'transparent') {
        const output = path.join(temp, 'ergebnis.webm');
        await runFfmpeg(tools.path('ffmpeg'), [
          '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', media.path, ...masks,
          '-filter_complex', `[0:v]fps=${fps},scale=${video.width}:${video.height},format=yuva420p[v];[1:v]${maskChain({ ...options, target: 'object' }, video)}[m];[v][m]alphamerge[out]`,
          '-map', '[out]', '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-pix_fmt', 'yuva420p', '-row-mt', '1', '-cpu-used', '4', '-an', output,
        ], {
          duration: end - start,
          signal: job.signal,
          onProgress: (part) => job.update({ progress: part * 100, detail: t('Stellt frei') }),
        });
        return await moveFile(output, options.folder, `${name} (${t('freigestellt')}).webm`);
      }

      const output = path.join(temp, 'ergebnis.mp4');
      const audio = media.hasAudio
        ? ['-map', '0:a:0', ...(['aac', 'mp3'].includes(media.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'])]
        : [];
      const filter = [
        `[0:v]fps=${fps},scale=${video.width}:${video.height},format=yuv420p,split[keep][src]`,
        `[src]${effectFilter({ effect: options.effect, strength: options.strength }, video)},format=yuva420p[fx]`,
        `[1:v]setpts=PTS+${start.toFixed(3)}/TB,${maskChain(options, video)}[m]`,
        '[fx][m]alphamerge[fg]',
        // Außerhalb des Abschnitts gibt es keine Maske, dort bleibt das Video unverändert.
        `[keep][fg]overlay=format=auto:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[out]`,
      ].join(';');
      await runFfmpeg(tools.path('ffmpeg'), [
        '-i', media.path, ...masks, '-filter_complex', filter, '-map', '[out]', ...audio,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
      ], {
        duration: media.duration,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: part * 100, detail: t('Rechnet Maske ein') }),
      });
      return await moveFile(output, options.folder, `${name} (${t('KI-Maske')}).mp4`);
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  }

  const handle = (channel, action) => ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, ...(await action(...args)) };
    } catch (error) {
      if (error instanceof CanceledError) return { ok: false, canceled: true };
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  // Ein Abbruch beendet den KI-Dienst, die Klicks und das geladene Video sind dann weg.
  function requireWorker() {
    if (!session || !worker || worker.closed) {
      throw new UserError(t('Die KI wurde beendet. Bereite den Abschnitt bitte neu vor.'));
    }
    return worker;
  }

  ipcMain.handle('ai:status', status);
  refreshSlowInfo();

  handle('ai:install', () => {
    queue.add({
      title: t('KI-Paket installieren'),
      kind: 'ai',
      run: (job) => runInstall(job).finally(refreshSlowInfo),
    });
  });

  handle('ai:downloadModel', (id) => {
    const model = findModel(id);
    queue.add({
      title: t('KI-Modell {name}', { name: model.label }),
      kind: 'ai',
      run: (job) => runDownload(model, job).finally(refreshSlowInfo),
    });
  });

  handle('ai:removeModel', async (id) => {
    stopWorker();
    await fs.rm(modelPath(findModel(id)), { force: true });
    refreshSlowInfo();
  });

  handle('ai:selectModel', (id) => {
    findModel(id);
    store.set('settings', { ...store.get('settings'), aiModel: id });
  });

  handle('ai:uninstall', async () => {
    stopWorker();
    await closeSession();
    await fs.rm(root, { recursive: true, force: true });
    refreshSlowInfo();
  });

  handle('ai:prepare', async (options) => {
    const media = await probeMedia(tools.path('ffprobe'), options.filePath);
    await new Promise((resolve, reject) => {
      queue.add({
        title: t('Vorbereiten: {name}', { name: media.name }),
        kind: 'ai',
        run: (job) => runPrepare(options, media, job).then(resolve, (error) => {
          reject(error);
          throw error;
        }),
      });
    });
    return { frames: session.frames, fps: session.fps, device: session.device };
  });

  handle('ai:points', async ({ frame, object, points, labels }) => {
    const preview = path.join(session.dir, `klick-${Date.now()}.png`);
    const result = await requireWorker().request({ type: 'points', frame, object, points, labels, preview });
    return result.empty ? { url: null } : { url: pathToFileURL(preview).href };
  });

  handle('ai:removeObject', async ({ object }) => {
    await requireWorker().request({ type: 'removeObject', object });
  });

  handle('ai:reset', async () => {
    await requireWorker().request({ type: 'reset' });
    session.tracked = false;
  });

  handle('ai:track', async () => {
    await new Promise((resolve, reject) => {
      queue.add({
        title: t('Verfolgen: {name}', { name: session.media.name }),
        kind: 'ai',
        run: (job) => runTrack(job).then(resolve, (error) => {
          reject(error);
          throw error;
        }),
      });
    });
    return { previewBase: pathToFileURL(path.join(session.dir, 'vorschau')).href };
  });

  handle('ai:export', (options) => {
    if (!session?.tracked) throw new UserError(t('Bitte verfolge das Objekt zuerst.'));
    queue.add({ title: session.media.name, kind: 'ai', run: (job) => runExport(options, job) });
  });

  register.dispose = () => {
    stopWorker();
    if (session) fsSync.rmSync(session.dir, { recursive: true, force: true });
  };
}

module.exports = { register, dispose: () => register.dispose?.() };
