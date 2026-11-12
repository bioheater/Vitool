// Findet heraus, wie weit und wie schnell eine Tonspur gegenüber einer anderen versetzt ist.
// Synchronfassungen teilen sich Musik und Geräusche mit dem Original. Deshalb passen ihre
// Lautstärkeverläufe zusammen, auch wenn die Stimmen verschieden sind.
const { spawn } = require('child_process');
const { CanceledError } = require('./process-runner');

const SAMPLE_RATE = 8000;
const BIN = 0.02;
const WINDOW = 90;
const SEARCH = 40;
const MAX_WINDOWS = 8;

// Typische Tempounterschiede zwischen Fassungen. Ein Wert über 1 heißt: Die Spur ist zu schnell
// und muss gedehnt werden.
const PAL = 25 / 23.976;
const PAL_24 = 25 / 24;
const NTSC = 24 / 23.976;
const KNOWN_STRETCHES = [
  { value: 1, kind: 'same' },
  { value: PAL, kind: 'pal-fast' },
  { value: 1 / PAL, kind: 'pal-slow' },
  { value: PAL_24, kind: 'pal-fast' },
  { value: 1 / PAL_24, kind: 'pal-slow' },
  { value: NTSC, kind: 'ntsc-fast' },
  { value: 1 / NTSC, kind: 'ntsc-slow' },
];

// Lautstärke (RMS) in festen Zeitabschnitten. Liegt der Anfang vor 0, wird mit Stille aufgefüllt.
function readEnvelope(ffmpeg, file, index, start, duration, bin, signal) {
  const count = Math.max(1, Math.round(duration / bin));
  const values = new Float32Array(count);
  const lead = start < 0 ? Math.round(-start / bin) : 0;
  const from = Math.max(0, start);
  const length = duration - lead * bin;
  if (length <= 0) return Promise.resolve(values);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CanceledError());
      return;
    }
    const child = spawn(ffmpeg, [
      '-v', 'error', '-nostdin', '-ss', from.toFixed(3), '-t', length.toFixed(3), '-i', file,
      '-map', `0:${index}`, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1',
    ], { windowsHide: true });
    const perBin = SAMPLE_RATE * bin;
    let sum = 0;
    let filled = 0;
    let slot = lead;
    let carry = null;
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      let data = chunk;
      if (carry) {
        data = Buffer.concat([carry, chunk]);
        carry = null;
      }
      const usable = data.length - (data.length % 2);
      if (usable < data.length) carry = data.subarray(usable);
      for (let offset = 0; offset < usable; offset += 2) {
        const sample = data.readInt16LE(offset) / 32768;
        sum += sample * sample;
        filled += 1;
        if (filled >= perBin) {
          if (slot < count) values[slot] = Math.sqrt(sum / filled);
          slot += 1;
          sum = 0;
          filled = 0;
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new CanceledError());
      else if (code !== 0) reject(new Error(stderr || `FFmpeg endete mit Code ${code}`));
      else {
        if (filled && slot < count) values[slot] = Math.sqrt(sum / filled);
        resolve(values);
      }
    });
  });
}

// Wie stark die Lautstärke gerade ansteigt. Einsätze von Musik und Geräuschen sind gut vergleichbar,
// der allgemeine Pegel einer Fassung spielt dann keine Rolle.
function onsets(envelope) {
  const result = new Float32Array(envelope.length);
  let previous = Math.log10(envelope[0] + 1e-4);
  for (let i = 1; i < envelope.length; i += 1) {
    const level = Math.log10(envelope[i] + 1e-4);
    result[i] = Math.max(0, level - previous);
    previous = level;
  }
  return result;
}

function resample(values, factor, length) {
  // Wert an Stelle j der gedehnten Folge liegt bei j / factor in der ursprünglichen.
  const result = new Float32Array(length);
  for (let j = 0; j < length; j += 1) {
    const position = j / factor;
    const i = Math.floor(position);
    if (i + 1 >= values.length) break;
    const part = position - i;
    result[j] = values[i] * (1 - part) + values[i + 1] * part;
  }
  return result;
}

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const next = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = next;
      }
    }
  }
}

// Sucht, an welcher Stelle von "search" das Stück "pattern" am besten passt (normierte Korrelation).
function bestMatch(pattern, search) {
  const m = pattern.length;
  const lags = search.length - m + 1;
  if (lags < 1) return null;
  let mean = 0;
  for (let i = 0; i < m; i += 1) mean += pattern[i];
  mean /= m;
  let norm = 0;
  for (let i = 0; i < m; i += 1) norm += (pattern[i] - mean) ** 2;
  norm = Math.sqrt(norm);
  if (norm === 0) return null;

  let size = 1;
  while (size < search.length + m) size <<= 1;
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  for (let i = 0; i < search.length; i += 1) aRe[i] = search[i];
  for (let i = 0; i < m; i += 1) bRe[i] = pattern[i] - mean;
  fft(aRe, aIm, false);
  fft(bRe, bIm, false);
  for (let i = 0; i < size; i += 1) {
    const re = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    const im = aIm[i] * bRe[i] - aRe[i] * bIm[i];
    aRe[i] = re;
    aIm[i] = im;
  }
  fft(aRe, aIm, true);

  const sums = new Float64Array(search.length + 1);
  const squares = new Float64Array(search.length + 1);
  for (let i = 0; i < search.length; i += 1) {
    sums[i + 1] = sums[i] + search[i];
    squares[i + 1] = squares[i] + search[i] * search[i];
  }
  const scores = new Float64Array(lags);
  let best = 0;
  for (let lag = 0; lag < lags; lag += 1) {
    const sum = sums[lag + m] - sums[lag];
    const spread = squares[lag + m] - squares[lag] - (sum * sum) / m;
    scores[lag] = spread > 1e-12 ? aRe[lag] / size / (norm * Math.sqrt(spread)) : 0;
    if (scores[lag] > scores[best]) best = lag;
  }
  // Zweitbeste Stelle mit Abstand: Liegt sie fast gleichauf, ist der Treffer unsicher.
  const gap = Math.round(0.5 / BIN);
  let second = 0;
  for (let lag = 0; lag < lags; lag += 1) {
    if (Math.abs(lag - best) > gap && scores[lag] > second) second = scores[lag];
  }
  let refined = best;
  if (best > 0 && best < lags - 1) {
    const [left, mid, right] = [scores[best - 1], scores[best], scores[best + 1]];
    const curve = left - 2 * mid + right;
    if (curve < 0) refined = best + (0.5 * (left - right)) / curve;
  }
  return { lag: refined, score: scores[best], ratio: second > 0 ? scores[best] / second : 10 };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function windowStarts(duration) {
  if (duration <= WINDOW * 1.5) return [0];
  const count = Math.max(2, Math.min(MAX_WINDOWS, Math.round(duration / 300)));
  const first = Math.min(30, duration * 0.05);
  const last = duration - WINDOW - Math.min(30, duration * 0.05);
  return Array.from({ length: count }, (_, i) => first + ((last - first) * i) / (count - 1));
}

// Einzelne Stellen dürfen knapp sein. Sicherheit entsteht erst, wenn mehrere denselben Versatz zeigen.
// Gibt es nur eine Stelle, muss sie dafür deutlich herausstechen.
function isReliable(match, windowCount) {
  return match.score > 0.05 && match.ratio > (windowCount === 1 ? 1.3 : 1.05);
}

// Fasst Stellen mit gleichem Versatz zusammen. Die größte Gruppe zuerst, bei Gleichstand die frühere.
// Mehrere Gruppen entstehen, wenn einer Fassung Szenen fehlen.
function groupOffsets(matches) {
  const groups = [];
  [...matches].sort((a, b) => a.time - b.time).forEach((match) => {
    const group = groups.find((entry) => Math.abs(median(entry.map((m) => m.offset)) - match.offset) < 0.15);
    if (group) group.push(match);
    else groups.push([match]);
  });
  // Einzelne Ausreißer zählen nur, wenn es überhaupt nur eine Stelle gibt.
  const real = matches.length === 1 ? groups : groups.filter((group) => group.length >= 2);
  return real.sort((a, b) => b.length - a.length || a[0].time - b[0].time);
}

function snapStretch(value) {
  const known = KNOWN_STRETCHES.find((entry) => Math.abs(entry.value / value - 1) < 0.0004);
  if (known) return known;
  return { value, kind: value > 1 ? 'other-fast' : 'other-slow' };
}

// reference und track: { file, index, duration }. Ergebnis: Ausgabezeit = Spurzeit × stretch + offset.
async function analyzeSync(ffmpeg, reference, track, { signal, onProgress } = {}) {
  const duration = Math.min(reference.duration || Infinity, (track.duration || Infinity) * 1.05);
  if (!Number.isFinite(duration) || duration < 10) throw new Error('too short');
  const starts = windowStarts(duration);
  const windowLength = Math.min(WINDOW, duration - 1);
  const minStretch = Math.min(...KNOWN_STRETCHES.map((entry) => entry.value));
  const maxStretch = Math.max(...KNOWN_STRETCHES.map((entry) => entry.value));

  const windows = [];
  for (const [number, start] of starts.entries()) {
    const ref = onsets(await readEnvelope(ffmpeg, reference.file, reference.index, start, windowLength, BIN, signal));
    const from = (start - SEARCH) / maxStretch;
    const to = (start + windowLength + SEARCH) / minStretch;
    const envelope = await readEnvelope(ffmpeg, track.file, track.index, from, to - from, BIN, signal);
    windows.push({ start, ref, from, envelope });
    onProgress?.(((number + 1) / starts.length) * 0.8);
  }

  // Jedes typische Tempo ausprobieren. Es gewinnt das, bei dem die meisten Stellen denselben Versatz zeigen.
  let best = null;
  for (const candidate of KNOWN_STRETCHES) {
    const matches = [];
    for (const { start, ref, from, envelope } of windows) {
      const stretched = onsets(resample(envelope, candidate.value, Math.floor(envelope.length * candidate.value)));
      // Die gedehnte Folge beginnt bei Spurzeit "from", also bei Ausgabezeit from × stretch.
      const lower = Math.max(0, Math.floor((start - SEARCH - from * candidate.value) / BIN));
      const upper = Math.min(stretched.length, Math.ceil((start + windowLength + SEARCH - from * candidate.value) / BIN));
      const match = bestMatch(ref, stretched.subarray(lower, upper));
      if (match) matches.push({ time: start, offset: start - (from * candidate.value + (lower + match.lag) * BIN), ...match });
      await new Promise((resolve) => setImmediate(resolve));
    }
    const reliable = matches.filter((match) => isReliable(match, windows.length));
    const groups = groupOffsets(reliable);
    if (groups.length === 0) continue;
    const [agreeing] = groups;
    const center = median(agreeing.map((match) => match.offset));
    const score = agreeing.reduce((total, match) => total + match.score, 0);
    if (!best || score > best.score) best = { candidate, groups, agreeing, center, score };
  }
  onProgress?.(1);

  const enough = windows.length === 1 ? 1 : 2;
  if (!best || best.agreeing.length < enough) return { found: false, checked: starts.length };

  // Bleibt innerhalb des gewählten Tempos eine kleine Drift, wird sie mit einer Geraden ausgeglichen.
  let stretch = best.candidate.value;
  let offset = best.center;
  const points = best.agreeing;
  if (points.length >= 3) {
    const meanTime = points.reduce((sum, p) => sum + p.time, 0) / points.length;
    const meanOffset = points.reduce((sum, p) => sum + p.offset, 0) / points.length;
    const slope = points.reduce((sum, p) => sum + (p.time - meanTime) * (p.offset - meanOffset), 0)
      / points.reduce((sum, p) => sum + (p.time - meanTime) ** 2, 0);
    const intercept = meanOffset - slope * meanTime;
    if (Math.abs(slope) * duration > 0.06) {
      stretch /= 1 - slope;
      offset = intercept / (1 - slope);
    } else {
      offset = intercept + slope * meanTime;
    }
  }
  const snapped = snapStretch(stretch);
  if (snapped.value !== stretch && snapped.kind !== 'other-fast' && snapped.kind !== 'other-slow') {
    // Auf das genaue Verhältnis runden und den Versatz dazu passend neu bestimmen.
    const scale = snapped.value / best.candidate.value;
    offset = median(points.map((p) => p.time - (p.time - p.offset) * scale));
  }

  return {
    found: true,
    offset: Math.round(offset * 1000) / 1000,
    stretch: snapped.value,
    kind: snapped.kind,
    checked: starts.length,
    agreeing: points.length,
    // Passen gute Stellen nicht zum gemeinsamen Versatz, fehlen vermutlich Szenen in einer Fassung.
    cutsDiffer: best.groups.length > 1,
    // Je Abschnitt des Films der dort passende Versatz, nach Zeit sortiert.
    sections: best.groups.length > 1
      ? best.groups.map((group) => ({ time: Math.min(...group.map((m) => m.time)), offset: Math.round(median(group.map((m) => m.offset)) * 1000) / 1000 }))
        .sort((a, b) => a.time - b.time)
      : [],
    confidence: (starts.length === 1 ? points[0].ratio > 2 : points.length >= Math.max(2, starts.length * 0.6)) ? 'high' : 'low',
  };
}

module.exports = { analyzeSync, readEnvelope, KNOWN_STRETCHES, PAL, NTSC };
