const { t } = require('../core/i18n');
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

const hasSpeakers = (transcript) => transcript.speakers > 0;
function speakerName(transcript, index) {
  return transcript.speakerNames?.[index]?.trim() || t('Sprecher {number}', { number: index + 1 });
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

// Wörter sammeln, bis Länge, Wortzahl oder Dauer erreicht sind, gern nach einem Satzzeichen.
// Whisper trennt manchmal mitten im Satz; die Untertitel laufen darüber hinweg, nur echte Pausen
// und ein Sprecherwechsel trennen.
function buildCues(segments, {
  maxChars = MAX_CUE_CHARS,
  maxWords = Infinity,
  maxSeconds = MAX_CUE_SECONDS,
  softBreak = SOFT_BREAK_CHARS,
} = {}) {
  const words = segments
    .filter((segment) => segment.text.trim())
    .flatMap((segment) => (!segment.edited && segment.words?.length ? segment.words : estimatedWords(segment))
      .map((word) => ({ ...word, speaker: segment.speaker })))
    .filter((word) => word.word.trim());
  const cues = [];
  let current = [];
  const textOf = (list) => list.map((entry) => entry.word).join('').trim();
  const flush = () => {
    if (current.length === 0) return;
    cues.push({ start: current[0].start, end: current.at(-1).end, text: textOf(current), words: current, speaker: current[0].speaker });
    current = [];
  };
  words.forEach((word) => {
    if (current.length > 0) {
      const tooLong = textOf([...current, word]).length > maxChars
        || current.length >= maxWords
        || word.end - current[0].start > maxSeconds;
      if (tooLong || word.start - current.at(-1).end > PAUSE_SECONDS || word.speaker !== current[0].speaker) flush();
    }
    current.push(word);
    const last = word.word.trim();
    if (/[.!?…]$/.test(last) || (textOf(current).length > softBreak && /[,;:]$/.test(last))) flush();
  });
  flush();
  return cues.filter((cue) => cue.text);
}

// SRT kennt keine Sprecher. Der Name steht vor dem Text, sobald jemand anderes spricht.
function toSrt(transcript) {
  let previous = null;
  return buildCues(transcript.segments)
    .map((cue, index) => {
      const named = hasSpeakers(transcript) && cue.speaker !== previous ? `${speakerName(transcript, cue.speaker)}: ${cue.text}` : cue.text;
      previous = cue.speaker;
      return `${index + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${wrap(named)}\n`;
    })
    .join('\n');
}

// WebVTT hat dafür eigene Stimmen-Tags, die Player als Namen anzeigen können.
function toVtt(transcript) {
  const body = buildCues(transcript.segments)
    .map((cue) => {
      const voice = hasSpeakers(transcript) ? `<v ${speakerName(transcript, cue.speaker).replace(/[<>&]/g, '')}>` : '';
      return `${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${voice}${wrap(cue.text)}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

// Fließtext: Eine längere Pause oder ein Sprecherwechsel beginnt einen neuen Absatz.
function toText(transcript) {
  const paragraphs = [];
  let previous = null;
  transcript.segments.filter((segment) => segment.text.trim()).forEach((segment) => {
    const changed = hasSpeakers(transcript) && segment.speaker !== previous?.speaker;
    if (!previous || changed || segment.start - previous.end > PARAGRAPH_GAP) {
      paragraphs.push({ speaker: changed || !previous ? segment.speaker : null, lines: [] });
    }
    paragraphs.at(-1).lines.push(segment.text.trim());
    previous = segment;
  });
  const named = (paragraph) => (hasSpeakers(transcript) && paragraph.speaker !== null ? `${speakerName(transcript, paragraph.speaker)}: ` : '');
  return `${paragraphs.map((paragraph) => named(paragraph) + paragraph.lines.join(' ')).join('\n\n')}\n`;
}

function toTimedText(transcript) {
  return `${transcript.segments
    .filter((segment) => segment.text.trim())
    .map((segment) => {
      const named = hasSpeakers(transcript) ? `${speakerName(transcript, segment.speaker)}: ` : '';
      return `[${stamp(segment.start, ',').slice(0, 8)}] ${named}${segment.text.trim()}`;
    })
    .join('\n')}\n`;
}

function toJson(transcript) {
  const speakers = hasSpeakers(transcript);
  return `${JSON.stringify({
    language: transcript.language,
    ...(speakers ? { speakers: Array.from({ length: transcript.speakers }, (_value, index) => speakerName(transcript, index)) } : {}),
    segments: transcript.segments.map(({ start, end, text, words, edited, speaker }) => ({
      start,
      end,
      ...(speakers ? { speaker: speakerName(transcript, speaker) } : {}),
      text,
      ...(edited ? {} : { words }),
    })),
  }, null, 2)}\n`;
}

const FORMATS = {
  srt: { label: t('SRT-Untertitel'), ext: 'srt', build: toSrt },
  vtt: { label: t('WebVTT-Untertitel'), ext: 'vtt', build: toVtt },
  txt: { label: t('Text'), ext: 'txt', build: toText },
  timed: { label: t('Text mit Zeitangaben'), ext: 'txt', suffix: t(' (mit Zeiten)'), build: toTimedText },
  json: { label: 'JSON', ext: 'json', build: toJson },
};

module.exports = { FORMATS, buildCues };
