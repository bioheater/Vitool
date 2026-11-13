import { t } from './i18n.js';
// Datei an einen anderen Bereich weitergeben. app.js meldet hier, wie ein Bereich geöffnet wird.
export const SEND_TARGETS = [
  { id: 'cut', label: t('Schneiden') },
  { id: 'convert', label: t('Konvertieren') },
  { id: 'tools', label: t('Werkzeuge') },
  { id: 'mkv', label: 'MKV' },
  { id: 'ai', label: t('KI-Maske') },
  { id: 'transcribe', label: t('Transkribieren') },
];

const MEDIA_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'wmv', 'flv', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'];

let navigate = null;

export function setNavigator(callback) {
  navigate = callback;
}

export function sendTo(pageId, filePath) {
  navigate?.(pageId, { filePath });
}

// Untertitel, Texte und Bilder lassen sich nicht weiterbearbeiten.
export function isMediaFile(filePath) {
  return MEDIA_EXTENSIONS.includes(String(filePath).split('.').pop().toLowerCase());
}

// Öffnet einen Bereich, etwa die Einstellungen an einer bestimmten Stelle.
export function openPage(pageId, data) {
  navigate?.(pageId, data);
}
