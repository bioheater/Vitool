// Speichert Einstellungen und Verlauf als JSON-Datei im Benutzerprofil.
const fs = require('fs');

class Store {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.data = { ...defaults, ...this.load() };
    this.data.settings = { ...defaults.settings, ...this.data.settings };
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
}

module.exports = { Store };
