// Übersetzungen. Der deutsche Text im Code ist zugleich der Schlüssel, jede weitere Sprache ist eine
// Datei in src/locales mit "deutscher Text": "Übersetzung". Fehlt ein Eintrag, erscheint der englische Text,
// bei Englisch selbst der deutsche.
// Platzhalter stehen in geschweiften Klammern: t('{count} Dateien', { count: 3 }).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Jede Sprache steht in ihrem eigenen Namen, damit man sie auch ohne Sprachkenntnisse findet.
const LANGUAGES = [
  { id: 'en', name: 'English' },
  { id: 'de', name: 'Deutsch' },
  { id: 'es', name: 'Español' },
  { id: 'fr', name: 'Français' },
  { id: 'pt-BR', name: 'Português (Brasil)' },
  { id: 'hi', name: 'हिन्दी' },
  { id: 'ja', name: '日本語' },
  { id: 'zh-CN', name: '简体中文' },
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
  // Fehlt in einer Sprache ein Text, steht dort der englische, nicht der deutsche.
  const read = (id) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'locales', `${id}.json`), 'utf8'));
    } catch {
      return {};
    }
  };
  if (language === 'de') strings = {};
  else if (language === 'en') strings = read('en');
  else strings = { ...read('en'), ...read(language) };
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
