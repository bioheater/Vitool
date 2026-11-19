// Zusammenfassen über einen Online-Dienst mit eigenem API-Schlüssel. Dabei geht der Text des Videos
// (Untertitel oder Transkript, Titel, Beschreibung) an den Anbieter, das Video und der Ton nicht.
// Der Schlüssel liegt verschlüsselt in den Einstellungen (Windows-Anmeldung, über safeStorage).
const { safeStorage } = require('electron');
const { UserError } = require('../core/error-messages');
const { t } = require('../core/i18n');

const PROVIDERS = {
  openai: { label: 'OpenAI', kind: 'openai', base: 'https://api.openai.com/v1', keyPage: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic (Claude)', kind: 'anthropic', base: 'https://api.anthropic.com', keyPage: 'https://console.anthropic.com/settings/keys' },
  gemini: { label: 'Google Gemini', kind: 'gemini', base: 'https://generativelanguage.googleapis.com', keyPage: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api/v1', keyPage: 'https://openrouter.ai/keys' },
  custom: { label: null, kind: 'openai', base: null, keyPage: null },
};
// Online-Modelle haben viel Kontext. Mehr als das liest Vitool trotzdem in Teilen, damit es bezahlbar bleibt.
const ONLINE_CONTEXT = 100000;
const MAX_ANSWER_TOKENS = 4096;
// Was keine Texte schreibt: Bilder, Ton, Embeddings und Moderation.
const labelOf = (provider) => PROVIDERS[provider].label ?? t('Anderer Dienst (OpenAI-kompatibel)');
const NOT_FOR_TEXT = /embed|tts|whisper|dall-e|moderation|image|audio|realtime|transcribe|search|computer-use|davinci|babbage/i;

function config(store) {
  const settings = store.get('settings');
  return settings.summaryOnline ?? { provider: 'openai', model: '', base: '' };
}

function keys(store) {
  return store.get('settings').summaryKeys ?? {};
}

function readKey(store, provider) {
  const stored = keys(store)[provider];
  if (!stored) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

function saveSettings(store, patch) {
  store.set('settings', { ...store.get('settings'), ...patch });
}

function baseUrl(provider, custom) {
  const base = PROVIDERS[provider]?.base ?? custom;
  if (!/^https?:\/\//i.test(base ?? '')) throw new UserError(t('Bitte gib die Adresse des Dienstes an, etwa https://…/v1.'));
  return base.replace(/\/$/, '');
}

function headersFor(provider, key) {
  const { kind } = PROVIDERS[provider];
  if (kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  if (kind === 'gemini') return { 'x-goog-api-key': key, 'content-type': 'application/json' };
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

async function failure(response) {
  const text = await response.text().catch(() => '');
  let detail = text.slice(0, 300);
  try {
    const data = JSON.parse(text);
    detail = data.error?.message ?? data.message ?? detail;
  } catch {
    // Kein JSON: dann der Anfang des Textes.
  }
  if (response.status === 401 || response.status === 403) return new UserError(t('Der Dienst hat den API-Schlüssel abgelehnt. Prüfe ihn bitte.'));
  if (response.status === 429) return new UserError(t('Der Dienst meldet zu viele Anfragen oder ein aufgebrauchtes Guthaben: {detail}', { detail }));
  return new UserError(t('Der Dienst meldet einen Fehler ({status}): {detail}', { status: response.status, detail }));
}

async function listModels({ provider, key, base }) {
  const url = baseUrl(provider, base);
  const { kind } = PROVIDERS[provider];
  const address = kind === 'gemini' ? `${url}/v1beta/models?pageSize=200` : kind === 'anthropic' ? `${url}/v1/models?limit=100` : `${url}/models`;
  const response = await fetch(address, { headers: headersFor(provider, key), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw await failure(response);
  const data = await response.json();
  if (kind === 'gemini') {
    return (data.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes('generateContent') && !NOT_FOR_TEXT.test(model.name))
      .map((model) => model.name.replace(/^models\//, ''));
  }
  return (data.data ?? []).map((model) => model.id).filter((id) => !NOT_FOR_TEXT.test(id)).sort();
}

// Liest einen Server-Sent-Events-Strom und gibt jede "data:"-Zeile als Objekt weiter.
async function readEvents(response, onData) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const value = line.trim();
      if (!value.startsWith('data:')) continue;
      const payload = value.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      onData(JSON.parse(payload));
    }
  }
}

async function chatOnline({ provider, key, base, model, messages, signal, onText }) {
  const url = baseUrl(provider, base);
  const { kind } = PROVIDERS[provider];
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  const rest = messages.filter((message) => message.role !== 'system');
  let address;
  let body;
  if (kind === 'anthropic') {
    address = `${url}/v1/messages`;
    body = { model, system, messages: rest, max_tokens: MAX_ANSWER_TOKENS, temperature: 0.3, stream: true };
  } else if (kind === 'gemini') {
    address = `${url}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: rest.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
      generationConfig: { temperature: 0.3 },
    };
  } else {
    address = `${url}/chat/completions`;
    body = { model, messages, stream: true, temperature: 0.3 };
  }
  const response = await fetch(address, { method: 'POST', headers: headersFor(provider, key), body: JSON.stringify(body), signal });
  if (!response.ok) throw await failure(response);
  let text = '';
  const add = (part) => {
    if (!part) return;
    text += part;
    onText?.(part);
  };
  await readEvents(response, (data) => {
    if (data.error) throw new UserError(t('Der Dienst meldet einen Fehler ({status}): {detail}', { status: '', detail: data.error.message ?? '' }));
    if (kind === 'anthropic') {
      if (data.type === 'content_block_delta') add(data.delta?.text);
    } else if (kind === 'gemini') {
      add((data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join(''));
    } else {
      add(data.choices?.[0]?.delta?.content);
    }
  });
  return text.trim();
}

function register({ ipcMain, store, shell }) {
  const publicConfig = () => {
    const current = config(store);
    return {
      ...current,
      encryption: safeStorage.isEncryptionAvailable(),
      providers: Object.entries(PROVIDERS).map(([id, provider]) => ({ id, label: labelOf(id), custom: !provider.base, keyPage: provider.keyPage, hasKey: Boolean(keys(store)[id]) })),
    };
  };

  ipcMain.handle('summary:onlineConfig', () => publicConfig());

  // Speichert Anbieter, Modell und Adresse. Ein neuer Schlüssel wird nur verschlüsselt abgelegt.
  ipcMain.handle('summary:onlineSave', (_event, { provider, model, base, key }) => {
    if (!PROVIDERS[provider]) return { ok: false, error: t('Diesen Dienst gibt es nicht.') };
    if (key) {
      if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: t('Windows kann den Schlüssel hier nicht verschlüsselt speichern.') };
      saveSettings(store, { summaryKeys: { ...keys(store), [provider]: safeStorage.encryptString(key.trim()).toString('base64') } });
    }
    saveSettings(store, { summaryOnline: { provider, model: model ?? '', base: base ?? '' } });
    return { ok: true, config: publicConfig() };
  });

  ipcMain.handle('summary:onlineForget', (_event, provider) => {
    const next = { ...keys(store) };
    delete next[provider];
    saveSettings(store, { summaryKeys: next });
    return publicConfig();
  });

  // Mit dem neu eingegebenen oder dem gespeicherten Schlüssel die Modelle des Anbieters abfragen.
  ipcMain.handle('summary:onlineModels', async (_event, { provider, base, key }) => {
    try {
      if (!PROVIDERS[provider]) throw new UserError(t('Diesen Dienst gibt es nicht.'));
      const usable = key?.trim() || readKey(store, provider);
      if (!usable) throw new UserError(t('Bitte gib zuerst deinen API-Schlüssel ein.'));
      return { ok: true, models: await listModels({ provider, key: usable, base }) };
    } catch (error) {
      return { ok: false, error: error instanceof UserError ? error.message : t('Der Dienst ist nicht erreichbar: {detail}', { detail: String(error?.message ?? error) }) };
    }
  });

  ipcMain.handle('summary:openKeyPage', (_event, provider) => {
    const page = PROVIDERS[provider]?.keyPage;
    if (page) shell.openExternal(page);
  });
}

// Für summary.js: der eingerichtete Dienst samt Schlüssel, oder ein Fehler mit Erklärung.
function onlineEngine(store) {
  const { provider, model, base } = config(store);
  if (!PROVIDERS[provider]) throw new UserError(t('Bitte richte zuerst einen Online-Dienst ein.'));
  const key = readKey(store, provider);
  if (!key) throw new UserError(t('Für {name} ist kein API-Schlüssel gespeichert.', { name: labelOf(provider) }));
  if (!model) throw new UserError(t('Bitte wähle ein Modell des Dienstes.'));
  return {
    label: labelOf(provider),
    limit: ONLINE_CONTEXT,
    chat: ({ messages, signal, onText }) => chatOnline({ provider, key, base, model, messages, signal, onText }),
  };
}

module.exports = { register, onlineEngine, PROVIDERS };
