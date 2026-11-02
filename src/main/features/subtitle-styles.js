// Untertitel-Styles zum Einbrennen. Dieselben Werte nutzt die Vorschau, damit beides gleich aussieht.
// Alle Größen sind Anteile der kürzeren Bildseite, so passen sie zu Quer- und Hochformat.
const { buildCues } = require('./transcript-formats');

const STYLES = {
  classic: { label: 'Klassisch', font: 'Arial', bold: true, size: 0.055, outline: 0.0045, shadow: 0.002 },
  box: { label: 'Box', font: 'Arial', bold: true, size: 0.052, box: 0.012 },
  highlight: { label: 'Wort für Wort', font: 'Arial', bold: true, size: 0.06, outline: 0.005, shadow: 0.002, highlight: true, maxChars: 48 },
  pop: { label: 'Pop', font: 'Arial Black', bold: false, size: 0.1, outline: 0.009, shadow: 0.003, highlight: true, upper: true, pop: true, maxChars: 18, maxWords: 3 },
};
const SIZES = { small: 0.8, medium: 1, large: 1.25 };
const POSITIONS = { bottom: 2, middle: 5, top: 8 };
const EDGE_MARGIN = 0.08;
const HOLD_SECONDS = 0.6;
const POP_MS = 90;

function lookFor(options, video) {
  const style = STYLES[options.style] ?? STYLES.classic;
  const unit = Math.min(video.width, video.height) * (SIZES[options.size] ?? 1);
  return {
    ...style,
    fontSize: style.size * unit,
    outlineSize: (style.outline ?? 0) * unit,
    shadowSize: (style.shadow ?? 0) * unit,
    boxSize: (style.box ?? 0) * unit,
    alignment: POSITIONS[options.position] ?? POSITIONS.bottom,
    margin: options.position === 'middle' ? 0 : EDGE_MARGIN * video.height,
    color: /^#[0-9a-f]{6}$/i.test(options.color ?? '') ? options.color : '#FFD400',
  };
}

// Wie viel Text in einen Untertitel passt, hängt von Bildbreite und Schriftgröße ab.
function cuesFor(transcript, options, video) {
  const look = lookFor(options, video);
  const charsPerLine = Math.max(12, Math.floor((0.9 * video.width) / (0.52 * look.fontSize)));
  const cues = buildCues(transcript.segments, {
    maxChars: Math.min(look.maxChars ?? Infinity, charsPerLine * 2, 84),
    maxWords: look.maxWords,
    maxSeconds: look.pop ? 2.5 : 6,
    softBreak: look.pop ? 0 : 30,
  });
  // Etwas länger stehen lassen, aber nie in den nächsten Untertitel hinein.
  return cues.map((cue, index) => {
    const next = cues[index + 1]?.start ?? Infinity;
    return {
      start: cue.start,
      end: Math.max(cue.end, Math.min(cue.end + HOLD_SECONDS, next)),
      words: cue.words.map((word) => ({ start: word.start, end: word.end, text: word.word.trim() })),
    };
  });
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

// ASS schreibt Farben als &HAABBGGRR, Alpha 00 ist deckend.
function assColor(hex, alpha = 0) {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((at) => value.slice(at, at + 2));
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}

function clean(text, upper) {
  const safe = text.replace(/[{}]/g, '').replace(/\\/g, '/');
  return upper ? safe.toLocaleUpperCase('de') : safe;
}

function toAss(transcript, options, video) {
  const look = lookFor(options, video);
  const cues = cuesFor(transcript, options, video);
  const white = assColor('#FFFFFF');
  const accent = assColor(look.color);
  const round = (value) => Math.max(0, Math.round(value * 10) / 10);
  const style = [
    'Vitool', look.font, round(look.fontSize), white, white,
    look.box ? assColor('#000000', 0x5a) : assColor('#000000'),
    assColor('#000000', 0x80),
    look.bold ? -1 : 0, 0, 0, 0, 100, 100, 0, 0,
    look.box ? 3 : 1,
    round(look.box ? look.boxSize : look.outlineSize),
    round(look.shadowSize),
    look.alignment,
    Math.round(video.width * 0.05), Math.round(video.width * 0.05), Math.round(look.margin), 1,
  ].join(',');

  const events = cues.flatMap((cue) => {
    const words = cue.words.map((word) => clean(word.text, look.upper));
    if (!look.highlight) {
      return [`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Vitool,,0,0,0,,${words.join(' ')}`];
    }
    // Für jedes Wort ein eigener Eintrag, in dem genau dieses Wort leuchtet.
    return cue.words.map((word, index) => {
      const start = index === 0 ? cue.start : word.start;
      const end = index === cue.words.length - 1 ? cue.end : cue.words[index + 1].start;
      const text = words.map((entry, at) => (at === index ? `{\\c${accent}}${entry}{\\c${white}}` : entry)).join(' ');
      const pop = look.pop && index === 0 ? `{\\fscx80\\fscy80\\t(0,${POP_MS},\\fscx100\\fscy100)}` : '';
      return { start, end, line: `${pop}${text}` };
    })
      .filter((entry) => assTime(entry.end) !== assTime(entry.start))
      .map((entry) => `Dialogue: 0,${assTime(entry.start)},${assTime(entry.end)},Vitool,,0,0,0,,${entry.line}`);
  });

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${style}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

module.exports = { STYLES, lookFor, cuesFor, toAss };
