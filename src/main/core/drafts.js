// Zwischenstände: Ergebnisse, die nur zum Weiterbearbeiten in einem anderen Bereich entstehen.
// Sie liegen in Vitools eigenem Ordner unter Temp und landen erst beim Speichern im Zielordner.
// Neben jeder Datei merkt sich eine kleine Notiz, wohin das Ergebnis später gehört.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { moveFile, uniquePath } = require('./files');
const { t } = require('./i18n');

const ROOT = path.join(os.tmpdir(), 'vitool-zwischenstaende');
const NOTE = 'vitool-ziel.json';
// Was so lange liegen bleibt, wird beim nächsten Start aufgeräumt.
const KEEP_DAYS = 3;

function isDraft(filePath) {
  if (!filePath) return false;
  const relative = path.relative(ROOT, path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Speichert ein fertiges Ergebnis: als Zwischenstand oder wie bisher im Zielordner.
async function saveResult(file, options, fileName) {
  if (!options.draft) return moveFile(file, options.folder, fileName);
  await fs.mkdir(ROOT, { recursive: true });
  const folder = await fs.mkdtemp(path.join(ROOT, 'stand-'));
  await fs.writeFile(path.join(folder, NOTE), JSON.stringify({ folder: options.folder ?? null }), 'utf8');
  return moveFile(file, folder, fileName);
}

// Der Ordner, in dem das Ergebnis einer Datei standardmäßig landet.
// Bei einem Zwischenstand ist das der Ordner der ursprünglichen Datei.
async function homeFolder(filePath) {
  if (!isDraft(filePath)) return path.dirname(filePath);
  try {
    const note = JSON.parse(await fs.readFile(path.join(path.dirname(filePath), NOTE), 'utf8'));
    if (note.folder) return note.folder;
  } catch {
    // Ohne Notiz bleibt nur der Download-Ordner des Nutzers.
  }
  return path.join(os.homedir(), 'Downloads');
}

// Kopiert einen Zwischenstand in einen richtigen Ordner. Der Zwischenstand selbst bleibt,
// falls er gerade noch in einem Bereich geöffnet ist.
async function keep(filePath, folder) {
  await fs.mkdir(folder, { recursive: true });
  const target = await uniquePath(folder, path.basename(filePath));
  await fs.copyFile(filePath, target);
  return target;
}

async function entries() {
  try {
    return (await fs.readdir(ROOT, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

async function folderSize(folder) {
  let total = 0;
  for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(folder, entry.name);
    total += entry.isDirectory() ? await folderSize(full) : (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function usage() {
  const list = await entries();
  let bytes = 0;
  for (const entry of list) bytes += await folderSize(path.join(ROOT, entry.name));
  return { count: list.length, bytes };
}

async function clear(maxAgeDays = 0) {
  const limit = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const entry of await entries()) {
    const folder = path.join(ROOT, entry.name);
    const stats = await fs.stat(folder).catch(() => null);
    if (stats && stats.mtimeMs <= limit) await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

function register({ ipcMain, queue }) {
  clear(KEEP_DAYS);

  ipcMain.handle('drafts:home', (_event, filePath) => homeFolder(filePath));
  ipcMain.handle('drafts:usage', () => usage());
  ipcMain.handle('drafts:clear', async () => {
    await clear(0);
    return usage();
  });
  ipcMain.handle('drafts:keep', (_event, { filePath, folder }) => {
    if (!isDraft(filePath) || !folder) return { ok: false };
    const jobId = queue.add({
      title: path.basename(filePath),
      kind: 'keep',
      run: async (job) => {
        job.update({ detail: t('Speichert …') });
        return keep(filePath, folder);
      },
    });
    return { ok: true, jobId };
  });
}

module.exports = { ROOT, KEEP_DAYS, isDraft, saveResult, homeFolder, register };
