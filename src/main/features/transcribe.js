// Bereich Transkribieren: freiwilliges Zusatzpaket mit faster-whisper.
// Nichts davon wird ohne ausdrücklichen Klick heruntergeladen, alles liegt im Ordner "transkription".
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { run, CanceledError } = require('../core/process-runner');
const { runFfmpeg, probeMedia } = require('../core/ffmpeg');
const {
  exec, findGpu, folderSizeGb, downloadFile, pythonScript, createEnvironment, installPackages, uninstallPackages, cleanUvCache,
} = require('../core/python-tools');
const { moveFile, uniquePath } = require('../core/files');
const { FORMATS } = require('./transcript-formats');
const { STYLES, lookFor, cuesFor, toAss } = require('./subtitle-styles');
const { commonArgs } = require('./download');
const { t } = require('../core/i18n');

const LINK_FILE_MARKER = 'VITOOLFILE|';
const LINK_PROGRESS_MARKER = 'VITOOLPROGRESS|';

const HF_BASE = 'https://huggingface.co';
const MODELS = [
  { id: 'small', repo: 'Systran/faster-whisper-small', label: 'Small', sizeMb: 464, text: t('Schnell, gut bei klarer Sprache') },
  { id: 'medium', repo: 'Systran/faster-whisper-medium', label: 'Medium', sizeMb: 1460, text: t('Genauer, deutlich langsamer') },
  { id: 'turbo', repo: 'dropbox-dash/faster-whisper-large-v3-turbo', label: 'Large Turbo', sizeMb: 1547, text: t('Sehr genau und trotzdem schnell'), recommended: true },
  { id: 'large', repo: 'Systran/faster-whisper-large-v3', label: 'Large', sizeMb: 2948, text: t('Am genauesten, am langsamsten') },
];
// Sprechererkennung mit pyannote. Das Modell ist frei, Hugging Face verlangt aber einmal die Zustimmung zu den Bedingungen.
// PyTorch für CUDA 12.8 läuft auch auf den neuesten NVIDIA-Karten.
const SPEAKER_PAGES = {
  model: `${HF_BASE}/pyannote/speaker-diarization-community-1`,
  token: `${HF_BASE}/settings/tokens`,
};
const TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu128';
const TORCH_VERSION = '2.11.0';
const SPEAKER_SIZE_MB = { gpu: 3500, cpu: 1100 };
const INSTALL_SIZE_GB = 1.5;
const INSTALL_SIZE_CPU_GB = 0.3;
const SKIPPED_FILES = ['.gitattributes', 'README.md'];

function register({ ipcMain, queue, store, tools, send, ytdlp }) {
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

  const speakerDir = path.join(modelDir, 'sprecher');
  const speakersReady = () => fsSync.existsSync(path.join(speakerDir, 'config.yaml'));
  const modelPath = (model) => path.join(modelDir, model.id);
  const findModel = (id) => {
    const model = MODELS.find((entry) => entry.id === id);
    if (!model) throw new UserError(t('Dieses Modell gibt es nicht.'));
    return model;
  };

  // Grafikkarte und Ordnergröße brauchen Sekunden und werden im Hintergrund nachgereicht.
  const slowInfo = { checked: false, gpu: null, usedGb: null };
  let slowCheck = null;

  function refreshSlowInfo() {
    slowCheck ??= (async () => {
      const [gpu, usedGb] = await Promise.all([
        findGpu(),
        fsSync.existsSync(markerFile) ? folderSizeGb(root) : 0,
      ]);
      Object.assign(slowInfo, { checked: true, gpu, usedGb: Number(usedGb.toFixed(1)) });
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
      gpu: slowInfo.gpu,
      installSizeGb: slowInfo.gpu || !slowInfo.checked ? INSTALL_SIZE_GB : INSTALL_SIZE_CPU_GB,
      freeGb: Math.floor((disk.bavail * disk.bsize) / 1024 ** 3),
      usedGb: installed ? slowInfo.usedGb : 0,
      selected: downloaded.some((model) => model.id === saved) ? saved : downloaded[0]?.id ?? saved,
      models: MODELS.map((model) => ({ ...model, downloaded: downloaded.includes(model) })),
      speakers: {
        installed: installed && speakersReady(),
        sizeMb: slowInfo.gpu || !slowInfo.checked ? SPEAKER_SIZE_MB.gpu : SPEAKER_SIZE_MB.cpu,
        pages: SPEAKER_PAGES,
      },
    };
  }

  // Erst die Pakete, dann das Modell. Scheitert nur das Modell am Zugang, geht der zweite Versuch schnell,
  // weil uv die Pakete dann schon hat. Der Token wird nur für den Download gebraucht und nirgends gespeichert.
  async function runSpeakerInstall(token, job) {
    const hasNvidia = Boolean(await exec('nvidia-smi', ['-L']));
    // Alles in einem Aufruf mit fester Version: Sonst zieht ein Hilfspaket später ein neueres PyTorch ohne Grafikkarte nach.
    job.update({ detail: hasNvidia ? t('Lädt PyTorch für die Grafikkarte, das dauert einige Minuten') : t('Lädt PyTorch'), progress: 2 });
    await installPackages(envDir, [`torch==${TORCH_VERSION}`, `torchaudio==${TORCH_VERSION}`, 'pyannote.audio'], {
      signal: job.signal,
      extraIndexUrl: hasNvidia ? TORCH_CUDA_INDEX : null,
    });

    job.update({ detail: t('Lädt das Modell zur Sprechererkennung'), progress: 90 });
    const partDir = `${speakerDir}.part`;
    await fs.rm(partDir, { recursive: true, force: true });
    let workerError = null;
    try {
      await run(envPython, ['-u', pythonScript('speaker_worker.py'), 'download', partDir], {
        signal: job.signal,
        // Ohne Token gilt eine vorhandene Anmeldung bei Hugging Face auf diesem Rechner.
        env: token ? { HF_TOKEN: token } : {},
        onLine: (line, stream) => {
          if (stream === 'stdout' && line.startsWith('{')) workerError = JSON.parse(line).error ?? workerError;
        },
      });
    } catch (error) {
      await fs.rm(partDir, { recursive: true, force: true });
      if (workerError === 'gated') {
        throw new UserError(t('Hugging Face hat den Zugang verweigert. Stimme auf der Modellseite den Bedingungen zu und gib einen Token ein.'));
      }
      if (workerError) throw new Error(workerError);
      throw error;
    }
    await fs.rm(speakerDir, { recursive: true, force: true });
    await fs.rename(partDir, speakerDir);
  }

  // Nur die Sprecher neu bestimmen: Der Text aus Whisper bleibt, auch mit Änderungen von Hand.
  async function redoSpeakers(options, media, job) {
    if (!speakersReady()) throw new UserError(t('Die Sprechererkennung ist noch nicht eingerichtet.'));
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-text-'));
    const audio = path.join(temp, 'ton.raw');
    const transcriptFile = path.join(temp, 'ergebnis.json');
    try {
      job.update({ detail: t('Liest den Ton'), progress: 0 });
      await runFfmpeg(tools.path('ffmpeg'), ['-i', media.path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', audio], {
        duration: media.duration,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: part * 10, detail: t('Liest den Ton') }),
      });
      const { speakerNames: _names, ...transcript } = options.transcript;
      await fs.writeFile(transcriptFile, JSON.stringify(transcript), 'utf8');
      await findSpeakers(options, audio, transcriptFile, job, 10);
      return JSON.parse(await fs.readFile(transcriptFile, 'utf8'));
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Zweite Runde nach Whisper: pyannote in einem eigenen Prozess, das Ergebnis ergänzt die Datei aus Whisper.
  async function findSpeakers(options, audio, transcriptFile, job, from) {
    const jobFile = path.join(path.dirname(transcriptFile), 'sprecher.json');
    await fs.writeFile(jobFile, JSON.stringify({
      model: speakerDir,
      audio,
      transcript: transcriptFile,
      count: Number(options.speakerCount) || null,
    }), 'utf8');
    let device = null;
    let workerError = null;
    await run(envPython, ['-u', pythonScript('speaker_worker.py'), jobFile], {
      signal: job.signal,
      onLine: (line, stream) => {
        if (stream !== 'stdout' || !line.startsWith('{')) return;
        const message = JSON.parse(line);
        if (message.device) device = message.device;
        if (message.error) workerError = message.error;
        if (message.progress !== undefined) {
          const where = device === 'cpu' ? t('Erkennt Sprecher (Prozessor, dauert länger)') : t('Erkennt Sprecher');
          job.update({ progress: from + message.progress * (100 - from), detail: where });
        }
      },
    }).catch((error) => {
      if (workerError === 'memory') throw new UserError(t('Der Speicher reicht für die Sprechererkennung nicht.'));
      if (workerError) throw new Error(workerError);
      throw error;
    });
  }

  // Python bringt uv selbst mit, auf dem Rechner muss keins installiert sein.
  async function runInstall(job) {
    const hasNvidia = Boolean(await exec('nvidia-smi', ['-L']));
    // Für die Grafikkarte braucht faster-whisper die CUDA-Bibliotheken, die es als Python-Pakete gibt.
    const packages = ['faster-whisper', ...(hasNvidia ? ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12==9.*'] : [])];

    await fs.mkdir(root, { recursive: true });
    job.update({ detail: t('Richtet Umgebung ein'), progress: 2 });
    await createEnvironment(envDir, { signal: job.signal });
    job.update({ detail: hasNvidia ? t('Lädt Whisper und Grafikkarten-Bibliotheken, das dauert einige Minuten') : t('Lädt Whisper'), progress: 10 });
    await installPackages(envDir, packages, { signal: job.signal });
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
            job.update({ progress: (loaded / total) * 100, detail: t('Lädt Modell {name}', { name: model.label }) });
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

  // Immer nur eine Erkennung gleichzeitig: Zwei Sprachmodelle würden sich Grafikkarte und Speicher teilen.
  let transcribeLock = Promise.resolve();

  const runTranscribe = (options, media, job) => exclusive(job, () => transcribeNow(options, media, job));

  async function exclusive(job, action) {
    const previous = transcribeLock;
    let release;
    transcribeLock = new Promise((resolve) => { release = resolve; });
    try {
      job.update({ detail: t('Wartet auf die vorige Transkription'), progress: null });
      await Promise.race([
        previous,
        new Promise((_resolve, reject) => {
          if (job.signal.aborted) reject(new CanceledError());
          job.signal.addEventListener('abort', () => reject(new CanceledError()), { once: true });
        }),
      ]);
      return await action();
    } finally {
      // Ein abgebrochener Wartender gibt erst frei, wenn sein Vorgänger fertig ist.
      previous.then(release);
    }
  }

  async function transcribeNow(options, media, job) {
    const model = findModel(options.model);
    const speakers = Boolean(options.speakers);
    if (speakers && !speakersReady()) throw new UserError(t('Die Sprechererkennung ist noch nicht eingerichtet.'));
    // Mit Sprechererkennung bekommt die zweite Runde das letzte Stück des Balkens.
    const textShare = speakers ? 60 : 95;
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-text-'));
    const audio = path.join(temp, 'ton.raw');
    const output = path.join(temp, 'ergebnis.json');
    const jobFile = path.join(temp, 'auftrag.json');

    try {
      job.update({ detail: t('Liest den Ton'), progress: 0 });
      await runFfmpeg(tools.path('ffmpeg'), ['-i', media.path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', audio], {
        duration: media.duration,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: part * 5, detail: t('Liest den Ton') }),
      });

      await fs.writeFile(jobFile, JSON.stringify({
        model: modelPath(model),
        audio,
        output,
        language: options.language || null,
        translate: Boolean(options.translate),
      }), 'utf8');
      job.update({ detail: t('Lädt Sprachmodell'), progress: 5 });
      let device = null;
      let workerError = null;
      const script = pythonScript('whisper_worker.py');
      await run(envPython, ['-u', script, jobFile], {
        signal: job.signal,
        onLine: (line, stream) => {
          if (stream !== 'stdout' || !line.startsWith('{')) return;
          const message = JSON.parse(line);
          if (message.device) device = message.device;
          if (message.error) workerError = message.error;
          if (message.progress !== undefined) {
            const where = device === 'cpu' ? t('Erkennt Sprache (Prozessor, dauert länger)') : t('Erkennt Sprache');
            job.update({ progress: 5 + message.progress * textShare, detail: where });
          }
        },
      }).catch((error) => {
        if (workerError === 'memory') throw new UserError(t('Der Arbeitsspeicher reicht nicht. Wähle ein kleineres Modell.'));
        if (workerError) throw new Error(workerError);
        throw error;
      });

      if (speakers) await findSpeakers(options, audio, output, job, 5 + textShare);
      const result = JSON.parse(await fs.readFile(output, 'utf8'));
      return { ...result, model: model.id, translated: Boolean(options.translate) };
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Lädt nur die Tonspur, das geht viel schneller als das ganze Video.
  // Zum Transkribieren genügt der Ton, zum Einbrennen braucht es das Video (höchstens 1080p).
  async function downloadFromLink(url, dir, job, { video = false, share = 1 } = {}) {
    const label = video ? t('Lädt Video') : t('Lädt Ton');
    const format = video
      ? ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b', '-S', 'vcodec:h264,acodec:aac', '--merge-output-format', 'mp4']
      : ['-f', 'ba/b'];
    let filePath = null;
    job.update({ detail: `${label} …` });
    await ytdlp.run([
      ...commonArgs(tools),
      '--ffmpeg-location', path.dirname(tools.path('ffmpegDownload') ?? tools.path('ffmpeg')),
      '--newline', '--progress', '--no-quiet',
      '--progress-template', `download:${LINK_PROGRESS_MARKER}%(progress._percent|)s`,
      '--print', `after_move:${LINK_FILE_MARKER}%(filepath)s`,
      // Ein Playlist-Link soll nie die ganze Liste laden.
      ...format, '--playlist-items', '1', '-P', dir, '-o', '%(title).100B.%(ext)s',
      '--', url,
    ], {
      signal: job.signal,
      onStatus: (detail, retrying) => {
        if (retrying) filePath = null;
        job.update({ detail, progress: null });
      },
      onLine: (line) => {
        if (line.startsWith(LINK_FILE_MARKER)) filePath = line.slice(LINK_FILE_MARKER.length).trim();
        if (line.startsWith(LINK_PROGRESS_MARKER)) {
          const value = Number.parseFloat(line.slice(LINK_PROGRESS_MARKER.length));
          if (Number.isFinite(value)) job.update({ progress: value * share, detail: label });
        }
      },
    });
    if (!filePath) throw new Error(t('Keine Datei erhalten'));
    return filePath;
  }

  async function runLinkDownload(url, job) {
    if (linkDir) await fs.rm(linkDir, { recursive: true, force: true }).catch(() => {});
    linkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-link-'));
    return downloadFromLink(url, linkDir, job);
  }

  async function runBurn(options, job) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
    try {
      const fromLink = Boolean(options.linkUrl);
      const source = fromLink
        ? await downloadFromLink(options.linkUrl, temp, job, { video: true, share: 0.4 })
        : options.filePath;
      const media = await probeMedia(tools.path('ffprobe'), source);
      if (!media.hasVideo) throw new UserError(t('Diese Datei hat kein Bild. Untertitel lassen sich nur in Videos einbrennen.'));

      await fs.writeFile(path.join(temp, 'untertitel.ass'), toAss(options.transcript, options, { width: media.width, height: media.height }), 'utf8');
      const output = path.join(temp, 'ergebnis.mp4');
      const audio = media.hasAudio
        ? ['-map', '0:a:0', ...(['aac', 'mp3'].includes(media.audioCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'])]
        : [];
      const start = fromLink ? 40 : 0;
      await runFfmpeg(tools.path('ffmpeg'), [
        '-i', source, '-map', '0:v:0', ...audio,
        // Über den relativen Namen entfallen die Sonderregeln für Windows-Pfade im Filter.
        '-vf', 'subtitles=untertitel.ass',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
      ], {
        cwd: temp,
        duration: media.duration,
        signal: job.signal,
        onProgress: (part) => job.update({ progress: start + part * (100 - start), detail: t('Brennt Untertitel ein') }),
      });

      const name = (options.name || path.parse(media.name).name).replace(/[<>:"/\\|?*]/g, '').trim() || 'Video';
      const folder = fromLink ? store.get('settings').downloadDir : path.dirname(options.filePath);
      return await moveFile(output, folder, `${name} (${t('mit Untertiteln')}).mp4`);
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

  ipcMain.handle('transcribe:status', status);
  refreshSlowInfo();

  handle('transcribe:install', () => {
    queue.add({ title: t('Transkription installieren'), kind: 'transcribe', run: (job) => runInstall(job).finally(refreshSlowInfo) });
  });

  handle('transcribe:downloadModel', (id) => {
    const model = findModel(id);
    queue.add({ title: t('Sprachmodell {name}', { name: model.label }), kind: 'transcribe', run: (job) => runDownload(model, job).finally(refreshSlowInfo) });
  });

  // Wartet auf das Ende, damit die Oberfläche eine Absage von Hugging Face direkt beim Token-Feld zeigen kann.
  handle('transcribe:installSpeakers', async (token) => {
    if (!fsSync.existsSync(markerFile)) throw new UserError(t('Zuerst muss die Transkription installiert sein.'));
    await new Promise((resolve, reject) => {
      queue.add({
        title: t('Sprechererkennung einrichten'),
        kind: 'transcribe',
        run: (job) => runSpeakerInstall(String(token ?? '').trim(), job).then(() => {
          resolve();
          return null;
        }, (error) => {
          reject(error);
          throw error;
        }).finally(refreshSlowInfo),
      });
    });
  });

  // PyTorch belegt die meisten Gigabytes und geht mit. Kleinere Hilfspakete bleiben in der Umgebung.
  handle('transcribe:removeSpeakers', async () => {
    await fs.rm(speakerDir, { recursive: true, force: true });
    await uninstallPackages(envDir, ['pyannote.audio', 'torch', 'torchaudio', 'torchcodec']).catch(() => {});
    await cleanUvCache();
    refreshSlowInfo();
  });

  // Nur diese beiden Seiten, kein beliebiger Link aus der Oberfläche.
  handle('transcribe:openSpeakerPage', (name) => {
    if (SPEAKER_PAGES[name]) shell.openExternal(SPEAKER_PAGES[name]);
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
    await cleanUvCache();
    refreshSlowInfo();
  });

  // Wartet, bis die Warteschlange fertig ist, und gibt den erkannten Text an die Oberfläche.
  handle('transcribe:start', async (options) => {
    const media = await probeMedia(tools.path('ffprobe'), options.filePath);
    if (!media.hasAudio) throw new UserError(t('Diese Datei hat keine Tonspur.'));
    const transcript = await new Promise((resolve, reject) => {
      queue.add({
        title: t('Transkribieren: {name}', { name: media.name }),
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

  handle('transcribe:speakers', async (options) => {
    if (!options.transcript?.segments?.length) throw new UserError(t('Es gibt noch keinen Text.'));
    const media = await probeMedia(tools.path('ffprobe'), options.filePath);
    const transcript = await new Promise((resolve, reject) => {
      queue.add({
        title: t('Sprecher erkennen: {name}', { name: media.name }),
        kind: 'transcribe',
        run: (job) => exclusive(job, () => redoSpeakers(options, media, job)).then((result) => {
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
        title: t('Ton aus Link laden ({site})', { site: new URL(url).hostname.replace(/^www\./, '') }),
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
    if (!target) throw new UserError(t('Dieses Format gibt es nicht.'));
    const parsed = path.parse(filePath);
    const folder = fromLink ? store.get('settings').downloadDir : parsed.dir;
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
      title: t('{format} speichern', { format: target.label }),
      defaultPath: path.join(folder, `${parsed.name}${target.suffix ?? ''}.${target.ext}`),
      filters: [{ name: target.label, extensions: [target.ext] }],
    });
    if (result.canceled) return { path: null };
    await fs.writeFile(result.filePath, target.build(transcript), 'utf8');
    return { path: result.filePath };
  });

  // Stapel: Jede Datei wird ein eigener Auftrag, die Ergebnisse landen ohne Nachfrage neben dem Original.
  async function runBatchFile(filePath, options, job) {
    const media = await probeMedia(tools.path('ffprobe'), filePath);
    if (!media.hasAudio) throw new UserError(t('Diese Datei hat keine Tonspur.'));
    const transcript = await runTranscribe(options, media, job);
    const { dir, name } = path.parse(filePath);
    let first = null;
    for (const format of options.formats) {
      const target = FORMATS[format];
      const file = await uniquePath(dir, `${name}${target.suffix ?? ''}.${target.ext}`);
      await fs.writeFile(file, target.build(transcript), 'utf8');
      first ??= file;
    }
    return first;
  }

  handle('transcribe:batch', (options) => {
    if (!options.files?.length) throw new UserError(t('Bitte wähle mindestens eine Datei.'));
    if (!options.formats?.length || options.formats.some((format) => !FORMATS[format])) {
      throw new UserError(t('Bitte wähle mindestens ein Format zum Speichern.'));
    }
    findModel(options.model);
    options.files.forEach((filePath) => {
      queue.add({
        title: t('Transkribieren: {name}', { name: path.basename(filePath) }),
        kind: 'transcribe',
        run: (job) => runBatchFile(filePath, options, job),
      });
    });
    return { count: options.files.length };
  });

  // Die Vorschau bekommt dieselben Untertitel und Maße wie das eingebrannte Video.
  handle('transcribe:cues', ({ transcript, options, video }) => {
    if (!STYLES[options.style]) throw new UserError(t('Diesen Style gibt es nicht.'));
    return { cues: cuesFor(transcript, options, video), look: lookFor(options, video) };
  });

  handle('transcribe:burn', (options) => {
    if (!STYLES[options.style]) throw new UserError(t('Diesen Style gibt es nicht.'));
    if (!options.transcript?.segments?.length) throw new UserError(t('Es gibt noch keinen Text zum Einbrennen.'));
    queue.add({
      title: t('Untertitel einbrennen: {name}', { name: options.name }),
      kind: 'transcribe',
      run: (job) => runBurn(options, job),
    });
  });

  register.dispose = () => {
    if (linkDir) fsSync.rmSync(linkDir, { recursive: true, force: true });
  };
}

module.exports = { register, dispose: () => register.dispose?.() };
