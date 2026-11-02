// Macht aus den erkannten Sätzen Untertitel und Textdateien.
const MAX_LINE = 42;
const MAX_CUE_CHARS = MAX_LINE * 2;
const MAX_CUE_SECONDS = 6;
const SOFT_BREAK_CHARS = 30;
const PAUSE_SECONDS = 1;
const PARAGRAPH_GAP = 1.5;

function stamp(seconds, separator) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

// Teilt einen Untertitel in höchstens zwei möglichst gleich lange Zeilen.
function wrap(text) {
  if (text.length <= MAX_LINE) return text;
  const words = text.split(' ');
  let best = null;
  for (let index = 1; index < words.length; index += 1) {
    const first = words.slice(0, index).join(' ');
    const second = words.slice(index).join(' ');
    const score = Math.max(first.length, second.length);
    if (!best || score < best.score) best = { score, text: `${first}\n${second}` };
  }
  return best?.text ?? text;
}

// Ohne passende Wortzeiten (Text wurde geändert): Zeit nach Zeichenanzahl auf die Wörter verteilen.
function estimatedWords(segment) {
  const words = segment.text.split(/\s+/).filter(Boolean);
  const total = words.reduce((sum, word) => sum + word.length + 1, 0) || 1;
  let time = segment.start;
  return words.map((word) => {
    const end = time + ((segment.end - segment.start) * (word.length + 1)) / total;
    const entry = { start: time, end, word: ` ${word}` };
    time = end;
    return entry;
  });
}

// Wörter sammeln, bis Länge oder Dauer erreicht sind, gern nach einem Satzzeichen.
// Whisper trennt manchmal mitten im Satz; die Untertitel laufen darüber hinweg, nur echte Pausen trennen.
function buildCues(segments) {
  const words = segments
    .filter((segment) => segment.text.trim())
    .flatMap((segment) => (!segment.edited && segment.words?.length ? segment.words : estimatedWords(segment)));
  const cues = [];
  let current = [];
  const textOf = (list) => list.map((entry) => entry.word).join('').trim();
  const flush = () => {
    if (current.length === 0) return;
    cues.push({ start: current[0].start, end: current.at(-1).end, text: textOf(current) });
    current = [];
  };
  words.forEach((word) => {
    if (current.length > 0) {
      const tooLong = textOf([...current, word]).length > MAX_CUE_CHARS || word.end - current[0].start > MAX_CUE_SECONDS;
      if (tooLong || word.start - current.at(-1).end > PAUSE_SECONDS) flush();
    }
    current.push(word);
    const last = word.word.trim();
    if (/[.!?…]$/.test(last) || (textOf(current).length > SOFT_BREAK_CHARS && /[,;:]$/.test(last))) flush();
  });
  flush();
  return cues.filter((cue) => cue.text);
}

function toSrt(segments) {
  return buildCues(segments)
    .map((cue, index) => `${index + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${wrap(cue.text)}\n`)
    .join('\n');
}

function toVtt(segments) {
  const body = buildCues(segments)
    .map((cue) => `${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${wrap(cue.text)}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

// Fließtext: Eine längere Pause beginnt einen neuen Absatz.
function toText(segments) {
  const paragraphs = [];
  let previousEnd = null;
  segments.filter((segment) => segment.text.trim()).forEach((segment) => {
    if (previousEnd === null || segment.start - previousEnd > PARAGRAPH_GAP) paragraphs.push([]);
    paragraphs.at(-1).push(segment.text.trim());
    previousEnd = segment.end;
  });
  return `${paragraphs.map((lines) => lines.join(' ')).join('\n\n')}\n`;
}

function toTimedText(segments) {
  return `${segments
    .filter((segment) => segment.text.trim())
    .map((segment) => `[${stamp(segment.start, ',').slice(0, 8)}] ${segment.text.trim()}`)
    .join('\n')}\n`;
}

function toJson(transcript) {
  return `${JSON.stringify({
    language: transcript.language,
    segments: transcript.segments.map(({ start, end, text, words, edited }) => ({ start, end, text, ...(edited ? {} : { words }) })),
  }, null, 2)}\n`;
}

const FORMATS = {
  srt: { label: 'SRT-Untertitel', ext: 'srt', build: (transcript) => toSrt(transcript.segments) },
  vtt: { label: 'WebVTT-Untertitel', ext: 'vtt', build: (transcript) => toVtt(transcript.segments) },
  txt: { label: 'Text', ext: 'txt', build: (transcript) => toText(transcript.segments) },
  timed: { label: 'Text mit Zeitangaben', ext: 'txt', suffix: ' (mit Zeiten)', build: (transcript) => toTimedText(transcript.segments) },
  json: { label: 'JSON', ext: 'json', build: toJson },
};

module.exports = { FORMATS };
