// Bereich Transkribieren: freiwilliges Zusatzpaket mit faster-whisper.
// Nichts davon wird ohne ausdrücklichen Klick heruntergeladen, alles liegt im Ordner "transkription".
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, dialog } = require('electron');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { run, CanceledError } = require('../core/process-runner');
const { runFfmpeg, probeMedia } = require('../core/ffmpeg');
const { exec, findPython, findGpu, folderSizeGb, downloadFile } = require('../core/python-tools');
const { FORMATS } = require('./transcript-formats');
const { commonArgs } = require('./download');

const LINK_FILE_MARKER = 'VITOOLFILE|';
const LINK_PROGRESS_MARKER = 'VITOOLPROGRESS|';

const HF_BASE = 'https://huggingface.co';
const MODELS = [
  { id: 'small', repo: 'Systran/faster-whisper-small', label: 'Small', sizeMb: 464, text: 'Schnell, gut bei klarer Sprache' },
  { id: 'medium', repo: 'Systran/faster-whisper-medium', label: 'Medium', sizeMb: 1460, text: 'Genauer, deutlich langsamer' },
  { id: 'turbo', repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo', label: 'Large Turbo', sizeMb: 1547, text: 'Sehr genau und trotzdem schnell', recommended: true },
  { id: 'large', repo: 'Systran/faster-whisper-large-v3', label: 'Large', sizeMb: 2948, text: 'Am genauesten, am langsamsten' },
];
const INSTALL_SIZE_GB = 1.5;
const INSTALL_SIZE_CPU_GB = 0.2;
const SKIPPED_FILES = ['.gitattributes', 'README.md'];

function register({ ipcMain, queue, store, tools, send }) {
  const root = path.join(app.getPath('userData'), 'transkription');
  const envDir = path.join(root, 'umgebung');
  const modelDir = path.join(root, 'modelle');
  const envPython = path.join(envDir, 'Scripts', 'python.exe');
  const markerFile = path.join(root, 'installiert.txt');

  // Ton aus einem Link liegt nur vorübergehend hier und wird beim nächsten Link oder beim Beenden gelöscht.
  // Reste aus einem abgestürzten Lauf räumt der Start weg.
  let linkDir = null;
  fs.readdir(os.tmpdir()).then((names) => names
    .filter((name) => name.startsWith('vitool-link-'))
    .forEach((name) => fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true }).catch(() => {})))
    .catch(() => {});

  const modelPath = (model) => path.join(modelDir, model.id);
  const findModel = (id) => {
    const model = MODELS.find((entry) => entry.id === id);
    if (!model) throw new UserError('Dieses Modell gibt es nicht.');
    return model;
  };

  // Python, Grafikkarte und Ordnergröße brauchen Sekunden und werden im Hintergrund nachgereicht.
  const slowInfo = { checked: false, python: null, gpu: null, usedGb: null };
  let slowCheck = null;

  function refreshSlowInfo() {
    slowCheck ??= (async () => {
      const [python, gpu, usedGb] = await Promise.all([
        findPython(),
        findGpu(),
        fsSync.existsSync(markerFile) ? folderSizeGb(root) : 0,
      ]);
      Object.assign(slowInfo, { checked: true, python, gpu, usedGb: Number(usedGb.toFixed(1)) });
      slowCheck = null;
      send('transcribe:statusChanged');
    })();
    return slowCheck;
  }

  async function status() {
    const installed = fsSync.existsSync(markerFile);
    const disk = await fs.statfs(app.getPath('userData'));
    const saved = store.get('settings').transcribeModel ?? 'turbo';
    const downloaded = MODELS.filter((model) => fsSync.existsSync(path.join(modelPath(model), 'model.bin')));
    return {
      installed,
      checked: slowInfo.checked,
      python: slowInfo.python,
      gpu: slowInfo.gpu,
      installSizeGb: slowInfo.gpu || !slowInfo.checked ? INSTALL_SIZE_GB : INSTALL_SIZE_CPU_GB,
      freeGb: Math.floor((disk.bavail * disk.bsize) / 1024 ** 3),
      usedGb: installed ? slowInfo.usedGb : 0,
      selected: downloaded.some((model) => model.id === saved) ? saved : downloaded[0]?.id ?? saved,
      models: MODELS.map((model) => ({ ...model, downloaded: downloaded.includes(model) })),
    };
  }

  async function runInstall(job) {
    const python = await findPython();
    if (!python) throw new UserError('Python wurde nicht gefunden.');
    const hasNvidia = Boolean(await exec('nvidia-smi', ['-L']));
    // Für die Grafikkarte braucht faster-whisper die CUDA-Bibliotheken, die es als Python-Pakete gibt.
    const packages = ['faster-whisper', ...(hasNvidia ? ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12==9.*'] : [])];

    await fs.mkdir(root, { recursive: true });
    job.update({ detail: 'Richtet Umgebung ein', progress: 2 });
    await run(python.path, ['-m', 'venv', envDir], { signal: job.signal });
    job.update({ detail: hasNvidia ? 'Lädt Whisper und Grafikkarten-Bibliotheken, das dauert einige Minuten' : 'Lädt Whisper', progress: 10 });
    await run(envPython, ['-m', 'pip', 'install', '--disable-pip-version-check', ...packages], { signal: job.signal });
    await fs.writeFile(markerFile, new Date().toISOString(), 'utf8');
  }

  // Ein Modell besteht aus mehreren Dateien. Es gilt erst als vorhanden, wenn der Ordner fertig umbenannt ist.
  async function runDownload(model, job) {
    const response = await fetch(`${HF_BASE}/api/models/${model.repo}/tree/main`, { signal: job.signal }).catch((error) => {
      if (job.signal.aborted) throw new CanceledError();
      throw error;
    });
    if (!response.ok) throw new Error(`Modell-Download fehlgeschlagen: ${response.status}`);
    const files = (await response.json()).filter((entry) => entry.type === 'file' && !SKIPPED_FILES.includes(entry.path));
    const total = files.reduce((sum, entry) => sum + entry.size, 0);

    const partDir = `${modelPath(model)}.part`;
    await fs.rm(partDir, { recursive: true, force: true });
    await fs.mkdir(partDir, { recursive: true });
    let loaded = 0;
    try {
      for (const entry of files) {
        await downloadFile(`${HF_BASE}/${model.repo}/resolve/main/${entry.path}`, path.join(partDir, entry.path), {
          signal: job.signal,
          onProgress: (bytes) => {
            loaded += bytes;
            job.update({ progress: (loaded / total) * 100, detail: `Lädt Modell ${model.label}` });
          },
        });
      }
    } catch (error) {
      await fs.rm(partDir, { recursive: true, force: true });
      throw error;
    }
    await fs.rm(modelPath(model), { recursive: true, force: true });
    await fs.rename(partDir, modelPath(model));
  }

  async function runTranscribe(options, media, job) {
    const model = findModel(options.model);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-text-'));
    const audio = path.join(temp, 'ton.raw');
    const output = path.join(temp, 'ergebnis.json');
    const jobFile = path.join(temp, 'auftrag.json');

    try {
      job.update({ detail: 'Liest den Ton', progress: 0 });
      await runFfmpeg(tools.path('ffmpeg'), ['-i', media.path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', audio], {
        duration: media.duration,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: part * 5, detail: 'Liest den Ton' }),
      });

      await fs.writeFile(jobFile, JSON.stringify({ model: modelPath(model), audio, output, language: options.language || null }), 'utf8');
      job.update({ detail: 'Lädt Sprachmodell', progress: 5 });
      let device = null;
      let workerError = null;
      const script = path.join(__dirname, '..', '..', 'python', 'whisper_worker.py');
      await run(envPython, ['-u', script, jobFile], {
        signal: job.signal,
        onLine: (line, stream) => {
          if (stream !== 'stdout' || !line.startsWith('{')) return;
          const message = JSON.parse(line);
          if (message.device) device = message.device;
          if (message.error) workerError = message.error;
          if (message.progress !== undefined) {
            const where = device === 'cpu' ? 'Erkennt Sprache (Prozessor, dauert länger)' : 'Erkennt Sprache';
            job.update({ progress: 5 + message.progress * 95, detail: where });
          }
        },
      }).catch((error) => {
        if (workerError === 'memory') throw new UserError('Der Arbeitsspeicher reicht nicht. Wähle ein kleineres Modell.');
        if (workerError) throw new Error(workerError);
        throw error;
      });

      const result = JSON.parse(await fs.readFile(output, 'utf8'));
      return { ...result, model: model.id };
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Lädt nur die Tonspur, das geht viel schneller als das ganze Video.
  async function runLinkDownload(url, job) {
    if (linkDir) await fs.rm(linkDir, { recursive: true, force: true }).catch(() => {});
    linkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-link-'));
    let filePath = null;
    job.update({ detail: 'Lädt Ton …' });
    await run(tools.path('ytdlp'), [
      ...commonArgs(tools),
      '--ffmpeg-location', path.dirname(tools.path('ffmpegDownload') ?? tools.path('ffmpeg')),
      '--newline', '--progress', '--no-quiet',
      '--progress-template', `download:${LINK_PROGRESS_MARKER}%(progress._percent|)s`,
      '--print', `after_move:${LINK_FILE_MARKER}%(filepath)s`,
      '-f', 'ba/b', '-P', linkDir, '-o', '%(title).100B.%(ext)s',
      '--', url,
    ], {
      signal: job.signal,
      onLine: (line) => {
        if (line.startsWith(LINK_FILE_MARKER)) filePath = line.slice(LINK_FILE_MARKER.length).trim();
        if (line.startsWith(LINK_PROGRESS_MARKER)) {
          const value = Number.parseFloat(line.slice(LINK_PROGRESS_MARKER.length));
          if (Number.isFinite(value)) job.update({ progress: value, detail: 'Lädt Ton' });
        }
      },
    });
    if (!filePath) throw new Error('Keine Datei erhalten');
    return filePath;
  }

  const handle = (channel, action) => ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, ...(await action(...args)) };
    } catch (error) {
      if (error instanceof CanceledError) return { ok: false, canceled: true };
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  ipcMain.handle('transcribe:status', status);
  refreshSlowInfo();

  handle('transcribe:install', () => {
    queue.add({ title: 'Transkription installieren', kind: 'transcribe', run: (job) => runInstall(job).finally(refreshSlowInfo) });
  });

  handle('transcribe:downloadModel', (id) => {
    const model = findModel(id);
    queue.add({ title: `Sprachmodell ${model.label}`, kind: 'transcribe', run: (job) => runDownload(model, job).finally(refreshSlowInfo) });
  });

  handle('transcribe:removeModel', async (id) => {
    await fs.rm(modelPath(findModel(id)), { recursive: true, force: true });
    refreshSlowInfo();
  });

  handle('transcribe:selectModel', (id) => {
    findModel(id);
    store.set('settings', { ...store.get('settings'), transcribeModel: id });
  });

  handle('transcribe:uninstall', async () => {
    await fs.rm(root, { recursive: true, force: true });
    refreshSlowInfo();
  });

  // Wartet, bis die Warteschlange fertig ist, und gibt den erkannten Text an die Oberfläche.
  handle('transcribe:start', async (options) => {
    const media = await probeMedia(tools.path('ffprobe'), options.filePath);
    if (!media.hasAudio) throw new UserError('Diese Datei hat keine Tonspur.');
    const transcript = await new Promise((resolve, reject) => {
      queue.add({
        title: `Transkribieren: ${media.name}`,
        kind: 'transcribe',
        run: (job) => runTranscribe(options, media, job).then((result) => {
          resolve(result);
          return null;
        }, (error) => {
          reject(error);
          throw error;
        }),
      });
    });
    return { transcript };
  });

  handle('transcribe:fromLink', async (url) => {
    if (!/^https?:\/\//i.test(url ?? '')) throw new UserError('Bitte gib einen gültigen Link ein.');
    const filePath = await new Promise((resolve, reject) => {
      queue.add({
        title: `Ton aus Link laden (${new URL(url).hostname.replace(/^www\./, '')})`,
        kind: 'transcribe',
        run: (job) => runLinkDownload(url, job).then((result) => {
          resolve(result);
          return null;
        }, (error) => {
          reject(error);
          throw error;
        }),
      });
    });
    const media = await probeMedia(tools.path('ffprobe'), filePath);
    return { media: { ...media, url: pathToFileURL(filePath).href, fromLink: url } };
  });

  // Ton aus einem Link liegt im Temp-Ordner, dort soll niemand speichern. Dann gilt der Download-Ordner.
  handle('transcribe:export', async ({ format, transcript, filePath, fromLink }) => {
    const target = FORMATS[format];
    if (!target) throw new UserError('Dieses Format gibt es nicht.');
    const parsed = path.parse(filePath);
    const folder = fromLink ? store.get('settings').downloadDir : parsed.dir;
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
      title: `${target.label} speichern`,
      defaultPath: path.join(folder, `${parsed.name}${target.suffix ?? ''}.${target.ext}`),
      filters: [{ name: target.label, extensions: [target.ext] }],
    });
    if (result.canceled) return { path: null };
    await fs.writeFile(result.filePath, target.build(transcript), 'utf8');
    return { path: result.filePath };
  });

  register.dispose = () => {
    if (linkDir) fsSync.rmSync(linkDir, { recursive: true, force: true });
  };
}

module.exports = { register, dispose: () => register.dispose?.() };
