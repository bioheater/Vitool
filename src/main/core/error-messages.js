// Übersetzt technische Fehlerausgaben in verständliche deutsche Meldungen.

// Für Fehler, die wir selbst formulieren und die unverändert angezeigt werden sollen.
class UserError extends Error {}

const RULES = [
  [/unsupported url|is not a valid url|no suitable extractor/i, 'Dieser Link wird nicht unterstützt. Prüfe bitte, ob er vollständig ist.'],
  [/not a bot|cookies.*authentication|use --cookies/i, 'Die Seite verlangt eine Anmeldung oder hält den Zugriff für automatisiert. Versuche es später noch einmal.'],
  [/confirm your age|age.?restricted|inappropriate for some users/i, 'Dieses Video hat eine Altersbeschränkung und lässt sich ohne Anmeldung nicht laden.'],
  [/private video|this video is private/i, 'Dieses Video ist privat und kann nicht geladen werden.'],
  [/members.only|join this channel/i, 'Dieses Video ist nur für Kanalmitglieder verfügbar.'],
  [/not available in your country|geo.?restrict|blocked it in your country/i, 'Dieses Video ist in deinem Land nicht verfügbar.'],
  [/video unavailable|has been removed|does not exist|http error 404/i, 'Dieses Video ist nicht mehr verfügbar.'],
  [/requested format is not available|no video formats found/i, 'Die gewählte Qualität ist für dieses Video nicht verfügbar. Wähle bitte eine andere.'],
  [/http error 429|too many requests/i, 'Die Seite hat vorübergehend zu viele Anfragen erhalten. Warte ein paar Minuten und versuche es erneut.'],
  [/http error 403|forbidden/i, 'Die Seite hat den Zugriff verweigert. Versuche es später noch einmal.'],
  [/no space left|not enough space|errno 28/i, 'Auf dem Laufwerk ist nicht genug Speicherplatz frei.'],
  [/permission denied|access is denied|zugriff verweigert|eperm|eacces|ebusy/i, 'Auf die Datei oder den Ordner konnte nicht zugegriffen werden. Sie ist vielleicht in einem anderen Programm geöffnet.'],
  [/getaddrinfo|timed out|connection (reset|refused|aborted)|network is unreachable|unable to download webpage/i, 'Keine Verbindung möglich. Prüfe bitte deine Internetverbindung.'],
  [/ffmpeg.*not (found|installed)|ffprobe.*not found/i, 'FFmpeg wurde nicht gefunden. Installiere es bitte und starte Vitool neu.'],
  [/invalid data found|moov atom not found|could not find codec parameters/i, 'Diese Datei lässt sich nicht lesen. Sie ist vielleicht beschädigt oder kein Video.'],
  [/KI-Dienst beendet|No module named|out of memory/i, 'Die KI konnte nicht arbeiten. Starte Vitool neu oder installiere das KI-Paket erneut.'],
  [/enoent/i, 'Ein benötigtes Programm wurde nicht gefunden. Starte Vitool neu, damit die Prüfung erneut läuft.'],
];

function toGermanMessage(error) {
  if (error instanceof UserError) return error.message;
  const text = String(error?.message ?? error);
  const rule = RULES.find(([pattern]) => pattern.test(text));
  if (rule) return rule[1];
  console.error('Unbekannter Fehler:', text);
  return 'Das hat leider nicht geklappt. Bitte versuche es noch einmal.';
}

module.exports = { UserError, toGermanMessage };
