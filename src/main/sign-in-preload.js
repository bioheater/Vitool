// Nur für das Anmeldefenster: Die Seite soll dasselbe sehen wie die Browserkennung, also Firefox.
// Chromium verrät sich sonst über navigator.userAgentData, und Google lehnt die Anmeldung ab.
const { contextBridge, webFrame } = require('electron');

function lookLikeFirefox() {
  const hide = (name, value) => {
    try {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    } catch {
      // Lässt sich eine Angabe nicht ändern, bleibt sie, wie sie ist.
    }
  };
  hide('userAgentData', undefined);
  hide('vendor', '');
}

if (contextBridge.executeInMainWorld) {
  contextBridge.executeInMainWorld({ func: lookLikeFirefox });
} else {
  webFrame.executeJavaScript(`(${lookLikeFirefox})()`);
}
