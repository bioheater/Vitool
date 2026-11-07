// Lädt yt-dlp, FFmpeg und Deno aus ihren offiziellen GitHub-Releases in den Datenordner von Vitool.
// Jede Datei wird gegen die Prüfsumme geprüft, die das jeweilige Projekt im selben Release veröffentlicht.
// Systemweit wird nichts installiert, über winget eingerichtete Programme bleiben als Ausweichlösung nutzbar.
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { run } = require('./process-runner');
const { UserError } = require('./error-messages');
const { downloadFile, sha256, uvFolder } = require('./python-tools');
const { t } = require('./i18n');

// provides: welche Werkzeuge der Prüfung damit erfüllt sind. Der FFmpeg-Build des yt-dlp-Teams
// taugt auch für das Laden von Abschnitten, deshalb deckt er "ffmpegDownload" gleich mit ab.
const DOWNLOADS = [
  {
    id: 'ytdlp', label: 'yt-dlp', repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp.exe', sums: 'SHA2-256SUMS', files: ['yt-dlp.exe'], provides: ['ytdlp'], sizeMb: 24,
  },
  {
    id: 'ffmpeg', label: 'FFmpeg', repo: 'yt-dlp/FFmpeg-Builds', asset: 'ffmpeg-master-latest-win64-gpl.zip', sums: 'checksums.sha256', files: ['ffmpeg.exe', 'ffprobe.exe'], provides: ['ffmpeg', 'ffprobe', 'ffmpegDownload'], sizeMb: 200,
  },
  {
    id: 'deno', label: 'Deno', repo: 'denoland/deno', asset: 'deno-x86_64-pc-windows-msvc.zip', sums: 'deno-x86_64-pc-windows-msvc.zip.sha256sum', files: ['deno.exe'], provides: ['deno'], sizeMb: 43,
  },
];

function binFolder() {
  return path.join(uvFolder(), 'bin');
}

// Welche Downloads für die fehlenden Werkzeuge nötig sind, jeder höchstens einmal.
function downloadsFor(missingIds) {
  return DOWNLOADS.filter((download) => download.provides.some((id) => missingIds.includes(id)));
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Vitool' } });
  if (!response.ok) throw new Error(`GitHub: ${response.status}`);
  return response.json();
}

// Die Prüfsummendateien haben je nach Projekt ein anderes Format: eine Zeile pro Datei (yt-dlp, FFmpeg)
// oder die Ausgabe von PowerShell, wo Name und Prüfsumme auf getrennten Zeilen stehen (Deno).
// Gilt die Zeile mit dem Namen nicht, zählt die einzige Prüfsumme der Datei.
function expectedHash(text, asset) {
  const hashOf = (line) => line.match(/\b[0-9a-f]{64}\b/i)?.[0];
  const lines = text.split(/\r?\n/);
  const named = lines.find((line) => line.includes(asset) && hashOf(line));
  const all = lines.map(hashOf).filter(Boolean);
  const hash = named ? hashOf(named) : all.length === 1 ? all[0] : null;
  if (!hash) throw new UserError(t('Für {name} wurde keine Prüfsumme gefunden.', { name: asset }));
  return hash.toLowerCase();
}

async function findFile(dir, name) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

async function installOne(download, { signal, onProgress }) {
  const release = await fetchJson(`https://api.github.com/repos/${download.repo}/releases/latest`, signal);
  const asset = release.assets.find((entry) => entry.name === download.asset);
  const sums = release.assets.find((entry) => entry.name === download.sums);
  if (!asset || !sums) throw new UserError(t('{name} ist gerade nicht zum Download verfügbar.', { name: download.label }));

  const work = path.join(uvFolder(), 'download', download.id);
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  try {
    const sumsFile = path.join(work, 'pruefsummen.txt');
    await downloadFile(sums.browser_download_url, sumsFile, { signal });
    const hash = expectedHash(await fs.readFile(sumsFile, 'utf8'), download.asset);

    const file = path.join(work, download.asset);
    await downloadFile(asset.browser_download_url, file, { signal, onProgress });
    if ((await sha256(file)) !== hash) throw new UserError(t('Die heruntergeladene Datei ist beschädigt. Bitte versuche es noch einmal.'));

    // Aus einem Archiv kommen nur die benötigten Programme, der Rest wird gleich wieder gelöscht.
    if (download.asset.endsWith('.zip')) {
      const unpacked = path.join(work, 'inhalt');
      await fs.mkdir(unpacked);
      await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', unpacked], { signal });
      await fs.mkdir(binFolder(), { recursive: true });
      for (const name of download.files) {
        const found = await findFile(unpacked, name);
        if (!found) throw new UserError(t('{name} fehlt im Download.', { name }));
        await fs.rm(path.join(binFolder(), name), { force: true });
        await fs.rename(found, path.join(binFolder(), name));
      }
    } else {
      await fs.mkdir(binFolder(), { recursive: true });
      await fs.rm(path.join(binFolder(), download.files[0]), { force: true });
      await fs.rename(file, path.join(binFolder(), download.files[0]));
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// Lädt nacheinander alles, was für die fehlenden Werkzeuge gebraucht wird. Der Balken folgt den Megabytes.
async function installTools(missingIds, job) {
  const downloads = downloadsFor(missingIds);
  const total = downloads.reduce((sum, download) => sum + download.sizeMb, 0) * 1e6;
  let done = 0;
  for (const download of downloads) {
    let loaded = 0;
    job.update({ detail: t('Lädt {name}', { name: download.label }), progress: (done / total) * 100 });
    await installOne(download, {
      signal: job.signal,
      onProgress: (bytes) => {
        loaded += bytes;
        job.update({ detail: t('Lädt {name}', { name: download.label }), progress: Math.min(99, ((done + loaded) / total) * 100) });
      },
    });
    done += download.sizeMb * 1e6;
  }
}

// yt-dlp kann sich selbst aktualisieren, wenn es die eigene Kopie von Vitool ist.
async function updateYtDlp() {
  const exe = path.join(binFolder(), 'yt-dlp.exe');
  if (!fsSync.existsSync(exe)) return null;
  const { stdout } = await run(exe, ['-U']);
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

module.exports = { DOWNLOADS, binFolder, downloadsFor, installTools, updateYtDlp };
