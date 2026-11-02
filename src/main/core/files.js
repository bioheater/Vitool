// Datei-Hilfen für alle Bereiche.
const fs = require('fs/promises');
const path = require('path');

// Bestehende Dateien bleiben erhalten: Bei gleichem Namen wird "(1)" angehängt.
async function uniquePath(folder, fileName) {
  const { name, ext } = path.parse(fileName);
  for (let counter = 0; ; counter += 1) {
    const candidate = path.join(folder, counter ? `${name} (${counter})${ext}` : fileName);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

async function moveFile(source, folder, fileName = path.basename(source)) {
  await fs.mkdir(folder, { recursive: true });
  const target = await uniquePath(folder, fileName);
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(source, target);
    await fs.rm(source);
  }
  return target;
}

const MEDIA_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ts', '.wmv', '.flv', '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus'];

// Alle Video- und Audiodateien direkt in einem Ordner, ohne Unterordner, alphabetisch sortiert.
async function listMediaFiles(folder) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(folder, entry.name))
    .sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
}

module.exports = { uniquePath, moveFile, listMediaFiles };
