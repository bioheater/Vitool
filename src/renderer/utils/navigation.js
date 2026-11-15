import { t } from './i18n.js';
// Datei an einen anderen Bereich weitergeben. app.js meldet hier, wie ein Bereich geöffnet wird.
export const SEND_TARGETS = [
  { id: 'cut', label: t('Schneiden') },
  { id: 'convert', label: t('Konvertieren') },
  { id: 'tools', label: t('Werkzeuge') },
  { id: 'mkv', label: 'MKV' },
  { id: 'audio', label: t('Ton') },
  { id: 'ai', label: t('KI-Maske') },
  { id: 'transcribe', label: t('Transkribieren') },
];

const MEDIA_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'wmv', 'flv', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'];

let navigate = null;
let currentPage = null;
// Aufgaben, deren Ergebnis gleich im nächsten Bereich weiterbearbeitet werden soll.
const followed = new Map();
const listeners = new Set();

export function setNavigator(callback) {
  navigate = callback;
}

export function setCurrentPage(pageId) {
  currentPage = pageId;
}

export function targetLabel(pageId) {
  return SEND_TARGETS.find((target) => target.id === pageId)?.label ?? pageId;
}

export function sendTo(pageId, filePath, extra = {}) {
  navigate?.(pageId, { filePath, ...extra });
}

// Untertitel, Texte und Bilder lassen sich nicht weiterbearbeiten.
export function isMediaFile(filePath) {
  return MEDIA_EXTENSIONS.includes(String(filePath).split('.').pop().toLowerCase());
}

// Öffnet einen Bereich, etwa die Einstellungen an einer bestimmten Stelle.
export function openPage(pageId, data) {
  navigate?.(pageId, data);
}

// Ist die Aufgabe fertig und steht der Nutzer noch im selben Bereich, öffnet sich das Ergebnis
// gleich im Ziel. Ist er inzwischen woanders, wartet in der Warteschlange ein Knopf dafür.
export function followJob(jobId, target) {
  followed.set(jobId, { target, from: currentPage });
  listeners.forEach((listener) => listener());
}

export function followTarget(jobId) {
  return followed.get(jobId)?.target ?? null;
}

export function forgetFollow(jobId) {
  followed.delete(jobId);
  listeners.forEach((listener) => listener());
}

export function onFollowChange(listener) {
  listeners.add(listener);
}

window.vitool.on('queue:update', (jobs) => {
  followed.forEach((entry, jobId) => {
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job || job.status === 'failed' || job.status === 'canceled') {
      followed.delete(jobId);
      return;
    }
    if (job.status !== 'done' || !job.resultPath || entry.opened) return;
    entry.opened = true;
    if (currentPage === entry.from) {
      followed.delete(jobId);
      sendTo(entry.target, job.resultPath);
    }
  });
});
