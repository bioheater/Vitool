// Sucht beim Start nach yt-dlp, FFmpeg, ffprobe und Deno.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TOOLS = [
  { id: 'ytdlp', exe: 'yt-dlp', label: 'yt-dlp', purpose: 'Lädt Videos herunter', required: true, versionArg: '--version', install: 'winget install yt-dlp.yt-dlp' },
  { id: 'ffmpeg', exe: 'ffmpeg', label: 'FFmpeg', purpose: 'Schneidet und konvertiert Videos', required: true, versionArg: '-version', install: 'winget install Gyan.FFmpeg' },
  { id: 'ffprobe', exe: 'ffprobe', label: 'ffprobe', purpose: 'Liest Videoinformationen (gehört zu FFmpeg)', required: true, versionArg: '-version', install: 'winget install Gyan.FFmpeg' },
  { id: 'deno', exe: 'deno', label: 'Deno', purpose: 'Wird für YouTube-Downloads gebraucht', required: false, versionArg: '--version', install: 'winget install DenoLand.Deno' },
  // Normale FFmpeg-Versionen können beim Laden von Abschnitten aus YouTube hängen bleiben.
  { id: 'ffmpegDownload', exe: 'ffmpeg', packagePrefix: 'yt-dlp.FFmpeg', label: 'FFmpeg für yt-dlp', purpose: 'Wird für das Laden von Abschnitten gebraucht', required: false, versionArg: '-version', install: 'winget install yt-dlp.FFmpeg' },
];

function exec(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

// Nach einer frischen Installation fehlt der Eintrag oft noch im Suchpfad dieses Prozesses.
function findInWinget(exe, packagePrefix = '') {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet');
  const link = path.join(base, 'Links', `${exe}.exe`);
  if (!packagePrefix && fs.existsSync(link)) return link;

  const walk = (dir, depth, prefix = '') => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const direct = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === `${exe}.exe`);
    if (direct) return path.join(dir, direct.name);
    if (depth === 0) return null;
    const folders = entries.filter((item) => item.isDirectory() && item.name.startsWith(prefix));
    for (const entry of folders) {
      const found = walk(path.join(dir, entry.name), depth - 1);
      if (found) return found;
    }
    return null;
  };
  return walk(path.join(base, 'Packages'), 3, packagePrefix);
}

async function locate({ exe, packagePrefix }) {
  if (packagePrefix) return findInWinget(exe, packagePrefix);
  const output = await exec('where.exe', [exe]);
  const fromPath = output?.split(/\r?\n/).find((line) => line.toLowerCase().endsWith('.exe'));
  return fromPath || findInWinget(exe);
}

class ToolChecker {
  constructor() {
    this.paths = {};
  }

  path(id) {
    return this.paths[id] ?? null;
  }

  async check() {
    const tools = await Promise.all(
      TOOLS.map(async (tool) => {
        const toolPath = await locate(tool);
        const output = toolPath ? await exec(toolPath, [tool.versionArg]) : null;
        const found = output !== null;
        this.paths[tool.id] = found ? toolPath : null;
        return {
          id: tool.id,
          label: tool.label,
          purpose: tool.purpose,
          required: tool.required,
          install: tool.install,
          found,
          version: found ? output.split(/\r?\n/)[0] : null,
        };
      }),
    );
    return { ok: tools.every((tool) => tool.found || !tool.required), tools };
  }
}

module.exports = { ToolChecker };
