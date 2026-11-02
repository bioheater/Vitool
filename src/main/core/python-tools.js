// Gemeinsame Helfer für die freiwilligen KI-Pakete: Python finden, Grafikkarte prüfen, Dateien laden.
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { createWriteStream } = require('fs');
const { UserError } = require('./error-messages');
const { CanceledError } = require('./process-runner');

function exec(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      resolve(error ? null : `${stdout}${stderr}`.trim());
    });
  });
}

async function findPython() {
  const output = await exec('where.exe', ['python']);
  const candidates = (output ?? '').split(/\r?\n/).filter((line) => line && !line.includes('WindowsApps'));
  for (const candidate of candidates) {
    const match = /Python (\d+)\.(\d+)/.exec((await exec(candidate, ['--version'])) ?? '');
    if (match && Number(match[1]) === 3 && Number(match[2]) >= 10) return { path: candidate, version: `${match[1]}.${match[2]}` };
  }
  return null;
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
    if (signal.aborted) throw new CanceledError();
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
    if (signal.aborted) throw new CanceledError();
    throw error;
  }
  if (total && loaded !== total) {
    await fs.rm(partPath, { force: true });
    throw new UserError('Der Download war unvollständig. Bitte versuche es noch einmal.');
  }
  await fs.rename(partPath, target);
}

module.exports = { exec, findPython, findGpu, folderSizeGb, downloadFile };
