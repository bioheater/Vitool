// Übersetzungen. Der deutsche Text im Code ist zugleich der Schlüssel, jede weitere Sprache ist eine
// Datei in src/locales mit "deutscher Text": "Übersetzung". Fehlt ein Eintrag, erscheint der deutsche Text.
// Platzhalter stehen in geschweiften Klammern: t('{count} Dateien', { count: 3 }).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const LANGUAGES = [
  { id: 'en', name: 'English' },
  { id: 'de', name: 'Deutsch' },
];
const DEFAULT_LANGUAGE = 'en';
const SETTINGS_FILE = 'vitool-daten.json';

let language = null;
let strings = {};

// Die Sprache wird beim ersten Text gelesen, auch wenn das schon beim Laden der Module passiert.
// Ein Wechsel gilt nach dem Neustart, den die Einstellungen dafür auslösen.
function load() {
  if (language) return;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), SETTINGS_FILE), 'utf8'));
    language = data.settings?.language;
  } catch {
    language = null;
  }
  if (!LANGUAGES.some((entry) => entry.id === language)) language = DEFAULT_LANGUAGE;
  try {
    strings = language === 'de' ? {} : JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'locales', `${language}.json`), 'utf8'));
  } catch {
    strings = {};
  }
}

function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

function t(key, params) {
  load();
  return fill(strings[key] ?? key, params);
}

function currentLanguage() {
  load();
  return language;
}

module.exports = { t, fill, currentLanguage, LANGUAGES, DEFAULT_LANGUAGE, translations: () => (load(), strings) };
