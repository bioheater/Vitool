// Bereich Zusammenfassen: holt den Text eines Videos und lässt ihn von einem lokalen Sprachmodell
// (Ollama) zusammenfassen. Das Video verlässt den PC dabei nicht, auch der Text nicht.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { dialog, shell, BrowserWindow } = require('electron');
const { UserError, toGermanMessage } = require('../core/error-messages');
const { run, CanceledError } = require('../core/process-runner');
const { runFfmpeg } = require('../core/ffmpeg');
const { t } = require('../core/i18n');
const online = require('./summary-online');

const OLLAMA_URL = (() => {
  const host = process.env.OLLAMA_HOST;
  if (!host) return 'http://127.0.0.1:11434';
  return /^https?:\/\//.test(host) ? host.replace(/\/$/, '') : `http://${host.replace(/^0\.0\.0\.0/, '127.0.0.1')}`;
})();
const OLLAMA_PAGE = 'https://ollama.com/download';
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.txt', '.json'];
const TEXT_SUBTITLE_CODECS = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];
// Zeilen werden zu Blöcken von etwa einer halben Minute zusammengefasst. Das spart Platz im Kontext
// und reicht für Kapitel mit Zeitmarken.
const BLOCK_SECONDS = 30;
// Grobe Schätzung: Ein Token sind im Deutschen etwa drei Zeichen.
const CHARS_PER_TOKEN = 3;
const ANSWER_TOKENS = 2500;
const MIN_CONTEXT = 8192;
// Mehr Kontext braucht viel Grafikspeicher. Längere Texte werden deshalb in Teilen gelesen.
const MAX_CONTEXT = 32768;
const CHUNK_TOKENS = 12000;

// ---------------------------------------------------------------- Ollama

async function ollama(pathName, options = {}) {
  const response = await fetch(`${OLLAMA_URL}${pathName}`, options);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      // Kein JSON, dann bleibt der Text.
    }
    throw new UserError(t('Ollama meldet einen Fehler: {message}', { message: message || response.status }));
  }
  return response;
}

async function ollamaStatus() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const { models = [] } = await response.json();
    return {
      running: true,
      models: models
        // Reine Embedding-Modelle können keinen Text schreiben.
        .filter((model) => !model.capabilities || model.capabilities.includes('completion'))
        .map((model) => ({
          name: model.name,
          size: model.size,
          parameters: model.details?.parameter_size ?? null,
          context: model.details?.context_length ?? null,
          thinking: Boolean(model.capabilities?.includes('thinking')),
        })),
    };
  } catch {
    return { running: false, models: [] };
  }
}

// Fragt das Modell und reicht den Text stückweise weiter, so wie er entsteht.
async function chat({ model, messages, context, thinking, signal, onText }) {
  const response = await ollama('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      // Nachdenken vor der Antwort dauert lange und bringt beim Zusammenfassen wenig.
      ...(thinking ? { think: false } : {}),
      options: { num_ctx: context, temperature: 0.3 },
    }),
  });
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const data = JSON.parse(line);
      if (data.error) throw new UserError(t('Ollama meldet einen Fehler: {message}', { message: data.error }));
      const part = data.message?.content ?? '';
      if (part) {
        text += part;
        onText?.(part);
      }
    }
  }
  return text.trim();
}

// ---------------------------------------------------------------- Texte lesen

function timeToSeconds(value) {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

const cleanText = (text) => text
  .replace(/<[^>]+>/g, '')
  .replace(/\{\\[^}]*\}/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();

// SRT und WebVTT: Zeitzeile "00:00:01,000 --> 00:00:03,000", darunter der Text.
function parseCues(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0) continue;
    const [start] = lines[index].split('-->');
    const content = cleanText(lines.slice(index + 1).join(' '));
    if (content) cues.push({ start: timeToSeconds(start), text: content });
  }
  return cues;
}

// YouTube-Untertitel im Format json3.
function parseJson3(data) {
  return (data.events ?? [])
    .filter((event) => event.segs)
    .map((event) => ({ start: (event.tStartMs ?? 0) / 1000, text: cleanText(event.segs.map((seg) => seg.utf8 ?? '').join('')) }))
    .filter((cue) => cue.text);
}

function parseTranscriptFile(text, ext) {
  if (ext === '.json') {
    const data = JSON.parse(text);
    if (Array.isArray(data.segments)) {
      return {
        cues: data.segments.map((segment) => ({
          start: Number(segment.start) || 0,
          text: cleanText(`${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text ?? ''}`),
        })).filter((cue) => cue.text),
        language: data.language ?? null,
      };
    }
    if (Array.isArray(data.events)) return { cues: parseJson3(data), language: null };
    throw new UserError(t('Diese JSON-Datei enthält kein Transkript.'));
  }
  if (ext === '.txt') {
    // Text aus Transkribieren mit Zeiten sieht etwa so aus: "[00:01:02] Sprecher 1: …"
    const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
    const timed = lines.map((line) => /^\[?(\d{1,2}:\d{2}(?::\d{2})?)(?:[.,]\d+)?\]?\s*(.*)$/.exec(line));
    if (timed.filter(Boolean).length > lines.length / 2) {
      return { cues: timed.filter(Boolean).map((match) => ({ start: timeToSeconds(match[1]), text: cleanText(match[2]) })).filter((cue) => cue.text), language: null };
    }
    return { cues: lines.map((line) => ({ start: null, text: cleanText(line) })), language: null };
  }
  return { cues: parseCues(text), language: null };
}

// Automatische Untertitel wiederholen Zeilen beim Weiterrollen. Doppeltes fällt weg, dann
// entstehen Blöcke mit Zeitmarke: "[12:34] Text …".
function toBlocks(cues) {
  const blocks = [];
  let last = '';
  for (const cue of cues) {
    let { text } = cue;
    if (text === last) continue;
    if (last && text.startsWith(last)) text = text.slice(last.length).trim();
    last = cue.text;
    if (!text) continue;
    const current = blocks.at(-1);
    if (current && (cue.start === null || cue.start - current.start < BLOCK_SECONDS)) current.text += ` ${text}`;
    else blocks.push({ start: cue.start, text });
  }
  return blocks;
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`;
}

const blockLine = (block) => (block.start === null ? block.text : `[${clock(block.start)}] ${block.text}`);

// ---------------------------------------------------------------- Quellen

function pickSubtitles(info) {
  const language = (info.language ?? '').split('-')[0];
  const manual = Object.entries(info.subtitles ?? {}).filter(([code]) => code !== 'live_chat');
  const auto = Object.entries(info.automatic_captions ?? {});
  const matches = (code) => language && code.split('-')[0] === language;
  const choice = manual.find(([code]) => matches(code))
    ?? manual[0]
    ?? auto.find(([code]) => code === `${language}-orig`)
    ?? auto.find(([code]) => code === language)
    ?? auto.find(([code]) => code.endsWith('-orig'))
    ?? null;
  if (!choice) return null;
  const [code, formats] = choice;
  const format = formats.find((entry) => entry.ext === 'json3') ?? formats.find((entry) => entry.ext === 'vtt')
    ?? formats.find((entry) => entry.ext === 'srt') ?? null;
  if (!format) return null;
  return { code, automatic: !manual.some(([manualCode]) => manualCode === code), format };
}

async function fromLink(url, { ytdlp, tools, signal }) {
  const base = ['--no-playlist', '--encoding', 'utf-8', ...(tools.path('deno') ? ['--js-runtimes', `deno:${tools.path('deno')}`] : [])];
  const { stdout } = await ytdlp.run([...base, '-J', '--skip-download', '--no-warnings', '--', url], { signal });
  const info = JSON.parse(stdout);
  const video = info.entries ? info.entries.find(Boolean) : info;
  if (!video) throw new UserError(t('Unter diesem Link wurde kein Video gefunden.'));
  const subtitles = pickSubtitles(video);
  if (!subtitles) {
    const error = new UserError(t('Für dieses Video gibt es keine Untertitel. Lade es herunter und lass es im Bereich Transkribieren erkennen.'));
    error.needsTranscript = true;
    throw error;
  }
  const response = await fetch(subtitles.format.url, { headers: subtitles.format.http_headers ?? {}, signal });
  if (!response.ok) throw new UserError(t('Die Untertitel ließen sich nicht laden.'));
  const text = await response.text();
  const cues = subtitles.format.ext === 'json3' ? parseJson3(JSON.parse(text)) : parseCues(text);
  return {
    title: video.title ?? t('Video'),
    uploader: video.uploader ?? video.channel ?? null,
    duration: video.duration ?? null,
    description: String(video.description ?? '').slice(0, 1500),
    language: subtitles.code.split('-')[0],
    source: subtitles.automatic ? 'auto' : 'subtitles',
    cues,
  };
}

async function extractEmbedded(filePath, tools, signal) {
  const { stdout } = await run(tools.path('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 's', filePath]);
  const streams = JSON.parse(stdout).streams ?? [];
  const stream = streams.find((entry) => TEXT_SUBTITLE_CODECS.includes(entry.codec_name));
  if (!stream) return null;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitool-'));
  try {
    const output = path.join(tempDir, 'untertitel.srt');
    await runFfmpeg(tools.path('ffmpeg'), ['-i', filePath, '-map', `0:${stream.index}`, '-c:s', 'srt', output], { signal });
    return { cues: parseCues(await fs.readFile(output, 'utf8')), language: stream.tags?.language ?? null };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fromFile(filePath, { tools, signal }) {
  const ext = path.extname(filePath).toLowerCase();
  const title = path.parse(filePath).name;
  if (SUBTITLE_EXTENSIONS.includes(ext)) {
    const { cues, language } = parseTranscriptFile(await fs.readFile(filePath, 'utf8'), ext);
    return { title, uploader: null, duration: null, description: '', language, source: 'file', cues };
  }
  // Untertitel mit gleichem Namen daneben, etwa "Film.srt" oder "Film.de.srt".
  const folder = path.dirname(filePath);
  const siblings = await fs.readdir(folder).catch(() => []);
  const sidecar = siblings.find((name) => name.startsWith(`${title}.`) && ['.srt', '.vtt'].includes(path.extname(name).toLowerCase()));
  if (sidecar) {
    const text = await fs.readFile(path.join(folder, sidecar), 'utf8');
    return { title, uploader: null, duration: null, description: '', language: null, source: 'sidecar', cues: parseCues(text) };
  }
  const embedded = await extractEmbedded(filePath, tools, signal);
  if (embedded?.cues.length) return { title, uploader: null, duration: null, description: '', language: embedded.language, source: 'embedded', cues: embedded.cues };
  const error = new UserError(t('In dieser Datei steckt kein Text. Lass sie zuerst im Bereich Transkribieren erkennen.'));
  error.needsTranscript = true;
  throw error;
}

// ---------------------------------------------------------------- Zusammenfassen

// Für die Anweisung an das Modell: der englische Name der Sprache, etwa "Japanese" für "ja".
function englishName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? 'English';
  } catch {
    return 'English';
  }
}

// Die Überschriften stehen schon in der Zielsprache, sonst übernimmt das Modell gern die englischen.
const HEADINGS = {
  de: { short: 'Kurzfassung', points: 'Wichtigste Punkte', chapters: 'Kapitel' },
  en: { short: 'Summary', points: 'Key points', chapters: 'Chapters' },
  es: { short: 'Resumen', points: 'Puntos clave', chapters: 'Capítulos' },
  fr: { short: 'Résumé', points: 'Points clés', chapters: 'Chapitres' },
  'pt-BR': { short: 'Resumo', points: 'Pontos principais', chapters: 'Capítulos' },
  hi: { short: 'सारांश', points: 'मुख्य बिंदु', chapters: 'अध्याय' },
  ja: { short: '要約', points: '主なポイント', chapters: 'チャプター' },
  'zh-CN': { short: '摘要', points: '要点', chapters: '章节' },
};

const PART_TEXT = {
  short: (heading) => `A section "## ${heading}": 3 to 6 sentences on what the video is about and what it concludes.`,
  points: (heading) => `A section "## ${heading}": 5 to 10 bullet points with the most important statements, facts and tips.`,
  chapters: (heading) => `A section "## ${heading}": 4 to 12 bullet points in the form "- mm:ss Title", using the time stamps of the transcript. The first chapter starts at 00:00.`,
};

function partInstruction(part, language) {
  const heading = HEADINGS[language]?.[part] ?? `${HEADINGS.en[part]} (translated into the output language)`;
  return PART_TEXT[part](heading);
}

function outputLanguage(language, transcriptLanguage) {
  if (language === 'video') return transcriptLanguage ? `the language of the transcript (${transcriptLanguage})` : 'the language of the transcript';
  return englishName(language);
}

function systemPrompt(language, transcriptLanguage) {
  return [
    'You summarize videos based on their transcript.',
    `Write everything, including the section headings, in ${outputLanguage(language, transcriptLanguage)}.`,
    'Only use what is said in the transcript. Do not invent anything and do not add an introduction or closing remark.',
    'Format the answer as Markdown with "## " headings and "- " bullet points.',
  ].join(' ');
}

function header(meta) {
  return [
    `Title: ${meta.title}`,
    meta.uploader ? `Channel: ${meta.uploader}` : null,
    meta.duration ? `Length: ${clock(meta.duration)}` : null,
    meta.description ? `Description: ${meta.description.replace(/\s+/g, ' ')}` : null,
  ].filter(Boolean).join('\n');
}

function chunkLines(lines, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > maxChars && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// Lokal über Ollama oder über einen Online-Dienst. Beide liefern dieselbe Schnittstelle.
async function resolveEngine(options, store) {
  if (options.engine === 'online') return online.onlineEngine(store);
  const status = await ollamaStatus();
  if (!status.running) throw new UserError(t('Ollama läuft nicht. Starte Ollama und versuche es noch einmal.'));
  const info = status.models.find((entry) => entry.name === options.model);
  if (!info) throw new UserError(t('Dieses Modell ist in Ollama nicht mehr vorhanden.'));
  const limit = Math.min(MAX_CONTEXT, info.context ?? MAX_CONTEXT);
  return {
    label: 'Ollama',
    limit,
    chat: ({ messages, signal, onText, context }) => chat({ model: options.model, thinking: info.thinking, messages, signal, onText, context: context ?? limit }),
  };
}

async function summarize(options, { signal, progress, store }) {
  const { parts, language, meta, blocks } = options;
  const engine = await resolveEngine(options, store);
  const { limit } = engine;
  const lines = blocks.map(blockLine);
  const text = lines.join('\n');
  const wanted = parts.filter((part) => PART_TEXT[part]);
  if (!wanted.length) throw new UserError(t('Bitte wähle aus, was die Zusammenfassung enthalten soll.'));
  const instructions = `Write:\n${wanted.map((part) => `- ${partInstruction(part, language)}`).join('\n')}`;
  const system = systemPrompt(language, meta.language);
  const base = { signal };

  let material = text;
  let materialName = 'Transcript';
  const needed = Math.ceil(text.length / CHARS_PER_TOKEN) + ANSWER_TOKENS + 800;
  if (needed > limit) {
    // Zu lang für einmal: erst jeden Teil in Notizen mit Zeitmarken, dann aus den Notizen die Zusammenfassung.
    const chunks = chunkLines(lines, Math.min(CHUNK_TOKENS, limit - ANSWER_TOKENS - 800) * CHARS_PER_TOKEN);
    const notes = [];
    for (const [index, chunk] of chunks.entries()) {
      progress({ phase: 'notes', part: index + 1, total: chunks.length });
      notes.push(await engine.chat({
        ...base,
        context: limit,
        messages: [
          { role: 'system', content: 'You take detailed notes on a part of a video transcript. Keep the time stamps in the form [mm:ss] at the start of each note. Write in English. Only use what is said.' },
          { role: 'user', content: `${header(meta)}\n\nPart ${index + 1} of ${chunks.length} of the transcript:\n${chunk.join('\n')}\n\nWrite 8 to 20 short notes, one per line, each starting with its time stamp.` },
        ],
      }));
    }
    material = notes.join('\n');
    materialName = 'Notes on the whole video, in order';
  }

  progress({ phase: 'write' });
  const context = Math.max(MIN_CONTEXT, Math.min(limit, Math.ceil(material.length / CHARS_PER_TOKEN) + ANSWER_TOKENS + 800));
  return engine.chat({
    ...base,
    context,
    onText: (part) => progress({ phase: 'write', text: part }),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${header(meta)}\n\n${materialName}:\n${material}\n\n${instructions}` },
    ],
  });
}

// ---------------------------------------------------------------- Chat zum Video

// Platz für den bisherigen Verlauf. Ältere Nachrichten fallen weg, wenn er voll ist.
const HISTORY_TOKENS = 4000;
const CHAT_ANSWER_TOKENS = 1500;
// Kurze Wörter wie "der", "and" oder "ist" helfen bei der Suche nach passenden Stellen nicht.
const MIN_TERM_LENGTH = 4;
const MAX_QUESTION_CHARS = 2000;

// So viele Zeichen Text passen neben Verlauf und Antwort in den Kontext.
function chatBudget(limit) {
  return Math.max(0, (limit - CHAT_ANSWER_TOKENS - HISTORY_TOKENS - 1000) * CHARS_PER_TOKEN);
}

async function chatLimit(options, store) {
  if (options.engine === 'online') return online.onlineEngine(store).limit;
  const status = await ollamaStatus();
  const info = status.models.find((entry) => entry.name === options.model);
  return Math.min(MAX_CONTEXT, info?.context ?? MAX_CONTEXT);
}

// Der neueste Teil des Verlaufs, der noch in den Platz passt, immer als Paar aus Frage und Antwort.
function recentHistory(history) {
  const clean = (Array.isArray(history) ? history : [])
    .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string' && message.content.trim())
    .map((message) => ({ role: message.role, content: message.content.slice(0, 8000) }));
  const kept = [];
  let size = 0;
  for (let index = clean.length - 1; index >= 0; index -= 1) {
    size += clean[index].content.length;
    if (size > HISTORY_TOKENS * CHARS_PER_TOKEN) break;
    kept.unshift(clean[index]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

const termsOf = (text) => [...new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  .filter((word) => word.length >= MIN_TERM_LENGTH || /^\d+$/.test(word))
  // Ein gekürzter Wortstamm findet auch "Kameras" bei "Kamera".
  .map((word) => (word.length > 6 ? word.slice(0, word.length - 2) : word));

// Für lange Videos: die Zeilen, in denen die Wörter der Frage vorkommen, samt ihren Nachbarn.
// Seltene Wörter zählen mehr als solche, die überall stehen.
function pickPassages(lines, query, maxChars) {
  const terms = termsOf(query);
  const lower = lines.map((line) => line.toLowerCase());
  const weights = terms.map((term) => {
    const count = lower.filter((line) => line.includes(term)).length;
    return count ? Math.log(1 + lines.length / count) : 0;
  });
  const scored = lower.map((line, index) => ({
    index,
    score: terms.reduce((sum, term, termIndex) => sum + (line.includes(term) ? weights[termIndex] : 0), 0),
  })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);

  const chosen = new Set();
  let size = 0;
  const take = (index) => {
    if (index < 0 || index >= lines.length || chosen.has(index)) return true;
    if (size + lines[index].length + 1 > maxChars) return false;
    chosen.add(index);
    size += lines[index].length + 1;
    return true;
  };
  for (const { index } of scored) {
    if (!take(index)) break;
    take(index - 1);
    take(index + 1);
  }
  // Ohne Treffer, etwa bei "Worum geht es?", wird gleichmäßig über das Video verteilt gelesen.
  if (!chosen.size) {
    const step = Math.max(1, Math.ceil(lines.reduce((sum, line) => sum + line.length + 1, 0) / Math.max(1, maxChars)));
    for (let index = 0; index < lines.length; index += step) if (!take(index)) break;
  }
  const sorted = [...chosen].sort((a, b) => a - b);
  return sorted.map((index, position) => (position && index !== sorted[position - 1] + 1 ? `…\n${lines[index]}` : lines[index])).join('\n');
}

function chatSystem(meta, material, excerpts) {
  return [
    'You talk with the user about one video. You know the video only from its transcript, which has time stamps in the form [mm:ss].',
    'Always answer in the language of the user\'s latest message, even if the transcript is in another language.',
    'Base statements about the video on the transcript and add the time stamp [mm:ss] where the video says it.',
    'If the transcript does not cover something, say so clearly. You may then add general knowledge, but mark it as not coming from the video.',
    'If the user wants to discuss, give a reasoned view and say which parts are your own assessment.',
    'Keep answers short and to the point unless the user asks for more detail. Use Markdown only for short lists and bold text.',
    excerpts
      ? 'The video is too long to show completely. You only see an overview and the passages that matched the question. If the answer could be in parts you do not see, say so.'
      : null,
    '',
    header(meta),
    '',
    material,
  ].filter((line) => line !== null).join('\n');
}

async function chatAbout(options, { signal, store, onText }) {
  const { meta, blocks } = options;
  const question = String(options.question ?? '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) throw new UserError(t('Bitte gib eine Frage ein.'));
  const engine = await resolveEngine(options, store);
  const lines = blocks.map(blockLine);
  const text = lines.join('\n');
  const history = recentHistory(options.history);
  const budget = chatBudget(engine.limit);
  const summary = String(options.summary ?? '').trim().slice(0, 6000);

  let material = `Transcript:\n${text}`;
  const excerpts = text.length > budget;
  if (excerpts) {
    // Die vorige Frage hilft bei Nachfragen wie "Und warum?".
    const previous = history.filter((message) => message.role === 'user').slice(-1).map((message) => message.content).join(' ');
    const overview = summary ? `Summary of the whole video:\n${summary}\n\n` : '';
    material = `${overview}Passages of the transcript that may matter for the question, in order:\n${pickPassages(lines, `${question} ${previous}`, budget - overview.length)}`;
  }
  const messages = [
    { role: 'system', content: chatSystem(meta, material, excerpts) },
    ...history,
    { role: 'user', content: question },
  ];
  const used = messages.reduce((sum, message) => sum + message.content.length, 0);
  const context = Math.max(MIN_CONTEXT, Math.min(engine.limit, Math.ceil(used / CHARS_PER_TOKEN) + CHAT_ANSWER_TOKENS + 500));
  const answer = await engine.chat({ signal, context, onText, messages });
  return { text: answer, excerpts };
}

// ---------------------------------------------------------------- IPC

// Segmente aus Transkribieren, ohne den Umweg über eine Datei.
function fromTranscript(transcript) {
  const names = transcript.speakerNames ?? [];
  const cues = (transcript.segments ?? []).map((segment) => {
    const speaker = Number.isInteger(segment.speaker) ? names[segment.speaker] : null;
    return { start: Number(segment.start) || 0, text: cleanText(`${speaker ? `${speaker}: ` : ''}${segment.text ?? ''}`) };
  }).filter((cue) => cue.text);
  return { title: transcript.title || t('Video'), uploader: null, duration: null, description: '', language: transcript.language ?? null, source: 'transcript', cues };
}

function register({ ipcMain, tools, ytdlp, send, store }) {
  let loading = null;
  let running = null;
  let chatting = null;
  online.register({ ipcMain, store, shell });

  const loaded = (meta) => {
    const blocks = toBlocks(meta.cues);
    if (!blocks.length) throw new UserError(t('In diesen Untertiteln steht kein Text.'));
    const { cues, ...rest } = meta;
    return { ok: true, meta: rest, blocks, words: blocks.reduce((sum, block) => sum + block.text.split(' ').length, 0) };
  };

  ipcMain.handle('summary:fromTranscript', (_event, transcript) => {
    try {
      return loaded(fromTranscript(transcript));
    } catch (error) {
      return { ok: false, error: toGermanMessage(error) };
    }
  });

  ipcMain.handle('summary:status', () => ollamaStatus());
  ipcMain.handle('summary:openOllama', () => shell.openExternal(OLLAMA_PAGE));

  ipcMain.handle('summary:load', async (_event, source) => {
    loading?.abort();
    const controller = new AbortController();
    loading = controller;
    try {
      const context = { tools, ytdlp, signal: controller.signal };
      const meta = /^https?:\/\//i.test(source ?? '') ? await fromLink(source, context) : await fromFile(source, context);
      return loaded(meta);
    } catch (error) {
      if (error instanceof CanceledError || controller.signal.aborted) return { ok: false, canceled: true };
      return { ok: false, error: toGermanMessage(error), needsTranscript: Boolean(error?.needsTranscript) };
    } finally {
      if (loading === controller) loading = null;
    }
  });

  ipcMain.handle('summary:start', async (_event, options) => {
    running?.abort();
    const controller = new AbortController();
    running = controller;
    try {
      store.set('settings', { ...store.get('settings'), summaryEngine: options.engine === 'online' ? 'online' : 'ollama', ...(options.model && options.engine !== 'online' ? { summaryModel: options.model } : {}) });
      const text = await summarize(options, {
        signal: controller.signal,
        store,
        progress: (data) => send('summary:progress', data),
      });
      // Manche Modelle denken so lange nach, dass für die Antwort kein Platz mehr bleibt.
      if (!text) throw new UserError(t('Das Modell hat keinen Text geliefert. Versuche es noch einmal oder wähle ein anderes Modell.'));
      return { ok: true, text };
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return { ok: false, canceled: true };
      const unreachable = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(String(error?.cause ?? error?.message ?? ''));
      let message = toGermanMessage(error);
      if (unreachable) {
        message = options.engine === 'online'
          ? t('Der Dienst ist nicht erreichbar. Prüfe die Internetverbindung und die Adresse.')
          : t('Ollama läuft nicht. Starte Ollama und versuche es noch einmal.');
      }
      return { ok: false, error: message };
    } finally {
      if (running === controller) running = null;
    }
  });

  // Passt der ganze Text neben dem Verlauf ins Modell? Sonst liest der Chat nur passende Stellen.
  ipcMain.handle('summary:chatFits', async (_event, { engine, model, chars }) => {
    try {
      return { ok: true, fits: chars <= chatBudget(await chatLimit({ engine, model }, store)) };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('summary:chat', async (_event, options) => {
    chatting?.abort();
    const controller = new AbortController();
    chatting = controller;
    try {
      const result = await chatAbout(options, {
        signal: controller.signal,
        store,
        onText: (text) => send('summary:chatProgress', { id: options.id, text }),
      });
      if (!result.text) throw new UserError(t('Das Modell hat keinen Text geliefert. Versuche es noch einmal oder wähle ein anderes Modell.'));
      return { ok: true, ...result };
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return { ok: false, canceled: true };
      const unreachable = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(String(error?.cause ?? error?.message ?? ''));
      let message = toGermanMessage(error);
      if (unreachable) {
        message = options.engine === 'online'
          ? t('Der Dienst ist nicht erreichbar. Prüfe die Internetverbindung und die Adresse.')
          : t('Ollama läuft nicht. Starte Ollama und versuche es noch einmal.');
      }
      return { ok: false, error: message };
    } finally {
      if (chatting === controller) chatting = null;
    }
  });

  ipcMain.handle('summary:chatCancel', () => chatting?.abort());

  // Zeitmarken aus dem Chat öffnen das Video im Browser an dieser Stelle. Nur echte Webadressen.
  ipcMain.handle('summary:openLinkAt', (_event, { url, seconds }) => {
    let address;
    try {
      address = new URL(url);
    } catch {
      return;
    }
    if (!['http:', 'https:'].includes(address.protocol)) return;
    address.searchParams.set('t', `${Math.max(0, Math.floor(Number(seconds) || 0))}s`);
    shell.openExternal(address.toString());
  });

  ipcMain.handle('summary:cancel', () => {
    running?.abort();
    loading?.abort();
  });

  ipcMain.handle('summary:save', async (event, { text, name }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      title: t('Zusammenfassung speichern'),
      defaultPath: path.join(store.get('settings').downloadDir ?? os.homedir(), `${name.replace(/[<>:"/\\|?*]/g, '')}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: t('Text'), extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    await fs.writeFile(result.filePath, `${text.trim()}\n`, 'utf8');
    return { ok: true, path: result.filePath };
  });
}

module.exports = { register, toBlocks, parseCues, parseTranscriptFile, pickSubtitles, pickPassages, recentHistory };
