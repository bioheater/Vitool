// Gemeinsame Helfer für die freiwilligen KI-Pakete: Umgebung einrichten, Grafikkarte prüfen, Dateien laden.
// Python muss nicht installiert sein: uv lädt ein eigenes Python in den Datenordner von Vitool
// und richtet damit die Umgebungen ein. Systemweit wird nichts verändert.
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createWriteStream } = require('fs');
const { app } = require('electron');
const { UserError } = require('./error-messages');
const { run, CanceledError } = require('./process-runner');
const { t } = require('./i18n');

// Feste Version mit bekannter Prüfsumme: Vitool führt nur genau diese Datei aus.
const UV_VERSION = '0.13.5';
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`;
const UV_SHA256 = 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a';
// Für diese Version gibt es PyTorch, SAM 2, faster-whisper und pyannote.
const PYTHON_VERSION = '3.12';

function exec(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      resolve(error ? null : `${stdout}${stderr}`.trim());
    });
  });
}

async function findGpu() {
  const output = await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
  return output?.split(/\r?\n/)[0] ?? null;
}

async function folderSizeGb(root) {
  let total = 0;
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(root);
  return total / 1024 ** 3;
}

// Lädt eine Datei erst unter ".part" und benennt sie erst um, wenn sie vollständig ist.
async function downloadFile(url, target, { signal, onProgress }) {
  const partPath = `${target}.part`;
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal?.aborted) throw new CanceledError();
    throw error;
  }
  if (!response.ok) throw new Error(`Modell-Download fehlgeschlagen: ${response.status}`);

  const total = Number(response.headers.get('content-length'));
  const file = createWriteStream(partPath);
  let loaded = 0;
  try {
    for await (const chunk of response.body) {
      loaded += chunk.length;
      if (!file.write(chunk)) await new Promise((resolve) => { file.once('drain', resolve); });
      onProgress?.(chunk.length, total);
    }
    await new Promise((resolve, reject) => { file.end((error) => (error ? reject(error) : resolve())); });
  } catch (error) {
    file.destroy();
    await fs.rm(partPath, { force: true });
    if (signal?.aborted) throw new CanceledError();
    throw error;
  }
  if (total && loaded !== total) {
    await fs.rm(partPath, { force: true });
    throw new UserError(t('Der Download war unvollständig. Bitte versuche es noch einmal.'));
  }
  await fs.rename(partPath, target);
}

// Im installierten Programm liegen die Skripte ausgepackt neben dem App-Archiv, weil Python dort nicht lesen kann.
function pythonScript(name) {
  return path.join(__dirname, '..', '..', 'python', name)
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

// uv, sein Python und sein Zwischenspeicher liegen zusammen im Datenordner. Der Zwischenspeicher
// verknüpft Dateien nur, deshalb belegen große Pakete wie PyTorch den Platz nicht doppelt.
function uvFolder() {
  return path.join(app.getPath('userData'), 'werkzeuge');
}

function uvEnv() {
  const folder = uvFolder();
  return {
    UV_PYTHON_INSTALL_DIR: path.join(folder, 'python'),
    UV_CACHE_DIR: path.join(folder, 'uv-cache'),
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_PROGRESS: '1',
  };
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Lädt uv beim ersten Zusatzpaket. Das Archiv wird geprüft und erst danach ausgepackt.
async function ensureUv({ signal }) {
  const folder = path.join(uvFolder(), `uv-${UV_VERSION}`);
  const exe = path.join(folder, 'uv.exe');
  if (fsSync.existsSync(exe)) return exe;

  await fs.mkdir(uvFolder(), { recursive: true });
  const archive = path.join(uvFolder(), `uv-${UV_VERSION}.zip`);
  await downloadFile(UV_URL, archive, { signal });
  try {
    if ((await sha256(archive)) !== UV_SHA256) throw new UserError(t('Die heruntergeladene Datei ist beschädigt. Bitte versuche es noch einmal.'));
    const partDir = `${folder}.part`;
    await fs.rm(partDir, { recursive: true, force: true });
    await fs.mkdir(partDir, { recursive: true });
    // Windows bringt tar mit, das auch ZIP-Archive auspackt.
    await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', partDir], { signal });
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rename(partDir, folder);
  } finally {
    await fs.rm(archive, { force: true });
  }
  return exe;
}

// Legt eine Umgebung mit dem eigenen Python von uv an. Fehlt dieses Python, lädt uv es dabei.
async function createEnvironment(envDir, { signal }) {
  const uv = await ensureUv({ signal });
  await run(uv, ['venv', '--python', PYTHON_VERSION, '--allow-existing', envDir], { signal, env: uvEnv() });
}

// Installiert Pakete in eine Umgebung. Bei mehreren Paketquellen gewinnt die passende Version,
// damit etwa PyTorch für die Grafikkarte nicht von der CPU-Fassung aus dem normalen Index verdrängt wird.
// buildWithInstalled baut ein Paket gegen das, was schon in der Umgebung liegt, statt dafür alles neu zu laden.
// Ein zweiter Versuch fängt ab, dass Windows eine frische Datei kurz sperrt, etwa während der Virenscanner sie prüft.
async function installPackages(envDir, packages, {
  signal, env = {}, indexUrl = null, extraIndexUrl = null, buildWithInstalled = false,
}) {
  const uv = await ensureUv({ signal });
  const python = path.join(envDir, 'Scripts', 'python.exe');
  const args = [
    'pip', 'install', '--python', python,
    ...(indexUrl ? ['--index-url', indexUrl] : []),
    ...(extraIndexUrl ? ['--extra-index-url', extraIndexUrl, '--index-strategy', 'unsafe-best-match'] : []),
    ...(buildWithInstalled ? ['--no-build-isolation'] : []),
    ...packages,
  ];
  const options = { signal, env: { ...uvEnv(), ...env } };
  try {
    await run(uv, args, options);
  } catch (error) {
    if (signal?.aborted || error instanceof CanceledError) throw error;
    await new Promise((resolve) => { setTimeout(resolve, 3000); });
    await run(uv, args, options);
  }
}

async function uninstallPackages(envDir, packages) {
  const uv = await ensureUv({});
  await run(uv, ['pip', 'uninstall', '--python', path.join(envDir, 'Scripts', 'python.exe'), ...packages], { env: uvEnv() });
}

// Nach dem Entfernen eines Pakets: Verknüpfungen im Zwischenspeicher lösen, damit der Platz frei wird.
async function cleanUvCache() {
  const exe = path.join(uvFolder(), `uv-${UV_VERSION}`, 'uv.exe');
  if (fsSync.existsSync(exe)) await run(exe, ['cache', 'clean'], { env: uvEnv() }).catch(() => {});
}

module.exports = {
  exec, findGpu, folderSizeGb, downloadFile, sha256, uvFolder, pythonScript, createEnvironment, installPackages, uninstallPackages, cleanUvCache,
};
