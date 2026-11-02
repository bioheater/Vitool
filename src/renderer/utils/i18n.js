// Übersetzungen für die Oberfläche. Die Texte kommen beim Start vom Hauptprozess (siehe core/i18n.js).
// Der deutsche Text ist der Schlüssel, Platzhalter stehen in geschweiften Klammern.
const { language, strings } = window.vitool.i18n;

export const LANGUAGE = language;

export function t(key, params) {
  const text = strings[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// Zahlen mit dem Dezimalzeichen der Sprache, etwa 1.5 oder 1,5.
export function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);
}

export function formatDate(date) {
  return new Date(date).toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' });
}
