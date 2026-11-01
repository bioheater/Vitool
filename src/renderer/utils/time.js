// Wandelt zwischen Sekunden und Anzeigezeiten wie 01:30 oder 1:02:03 um.

export function formatTime(value, withTenths = false) {
  const tenths = Math.round(Math.max(0, value) * 10);
  const total = Math.floor(tenths / 10);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (number) => String(number).padStart(2, '0');
  const base = hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  const fraction = tenths % 10;
  return withTenths && fraction ? `${base}.${fraction}` : base;
}

// Erlaubt 90, 1:30, 01:30.5 und 1:02:03. Gibt null zurück, wenn die Eingabe ungültig ist.
export function parseTime(text) {
  const match = /^(?:(\d+):)?(?:(\d{1,2}):)?(\d+(?:[.,]\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const parts = text.trim().replace(',', '.').split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length > 1 && parts.slice(1).some((part) => part >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
