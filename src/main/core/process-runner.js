// Startet externe Programme (yt-dlp, FFmpeg) und liefert ihre Ausgabe Zeile für Zeile.
const { spawn, execFile } = require('child_process');

function killTree(pid) {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
}

function splitLines(onLine) {
  let rest = '';
  return (chunk) => {
    rest += chunk;
    const parts = rest.split(/\r\n|\r|\n/);
    rest = parts.pop();
    parts.filter(Boolean).forEach(onLine);
  };
}

function run(command, args, { onLine, signal, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CanceledError());
      return;
    }

    const child = spawn(command, args, {
      windowsHide: true,
      cwd,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...env },
    });

    let stdout = '';
    let stderr = '';
    const handleOut = splitLines((line) => onLine?.(line, 'stdout'));
    const handleErr = splitLines((line) => onLine?.(line, 'stderr'));

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      handleOut(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      handleErr(chunk);
    });

    const onAbort = () => killTree(child.pid);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new CanceledError());
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(stderr || `Programm endete mit Code ${code}`);
        error.code = code;
        reject(error);
      }
    });
  });
}

class CanceledError extends Error {
  constructor() {
    super('Abgebrochen');
    this.name = 'CanceledError';
  }
}

module.exports = { run, CanceledError };
