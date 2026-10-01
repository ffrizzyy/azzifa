// One function, generateText(prompt), that hides which AI provider is actually being called.
// Swapping providers is a .env change (AI_PROVIDER=...), not a code change.

// `kind` tells the route what to say to the person using the app; `message` is the technical
// detail for the server log and is never shown to them.
//   unconfigured — the server owner has not set a provider up
//   refusal      — the provider declined to answer
//   upstream     — the provider failed, timed out, or answered with something unusable
class ProviderError extends Error {
  constructor(message, kind = 'upstream') {
    super(message);
    this.kind = kind;
  }
}

const TIMEOUT_MS = 45000;
// Many current models — Claude, and reasoning models on OpenAI-compatible providers such as
// gpt-oss on Groq — think before they answer, and that thinking is counted against max_tokens.
// A cap sized for the answer alone can be used up before any text is written, so every request
// gets generous headroom; the prompts themselves keep the answer short. AI_MIN_TOKENS lowers it
// for a small local model whose context cannot hold that much.
const MIN_TOKENS = Number(process.env.AI_MIN_TOKENS) || 4000;

const providerName = () => (process.env.AI_PROVIDER || 'anthropic').toLowerCase();

/** What the app can tell people about the AI behind it, without making a request. */
function providerInfo() {
  const provider = providerName();
  if (provider === 'anthropic') return { configured: !!process.env.ANTHROPIC_API_KEY, label: 'Claude' };
  if (provider === 'openai') return { configured: !!process.env.OPENAI_API_KEY, label: 'OpenAI' };
  if (provider === 'openai_compatible') return { configured: !!(process.env.AI_BASE_URL && process.env.AI_MODEL), label: 'penyedia AI' };
  return { configured: false, label: 'penyedia AI' };
}

// A provider that never answers must not leave the request hanging forever.
async function post(url, headers, body) {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ProviderError(`${url} tidak bisa dihubungi: ${e.message}`);
  }
}

async function callAnthropic(prompt, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ProviderError('ANTHROPIC_API_KEY belum diatur di .env', 'unconfigured');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const resp = await post('https://api.anthropic.com/v1/messages', {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  }, {
    model,
    max_tokens: Math.max(maxTokens, MIN_TOKENS),
    messages: [{ role: 'user', content: prompt }],
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new ProviderError(`Anthropic API menolak permintaan (${resp.status}) — cek ANTHROPIC_API_KEY dan ANTHROPIC_MODEL. ${body}`);
  }
  const data = await resp.json();
  if (data.stop_reason === 'refusal') throw new ProviderError('Anthropic API menolak menjawab (refusal)', 'refusal');
  // Only text blocks are the answer; thinking blocks come back in the same list.
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new ProviderError(`Anthropic API mengembalikan respons tanpa teks (stop_reason: ${data.stop_reason})`);
  return text;
}

// Shared by OpenAI itself and anything that speaks the same /chat/completions shape
// (Groq, Together, Mistral, a local Ollama behind an OpenAI-compatible shim, etc.)
async function callOpenAiShaped(url, key, model, prompt, maxTokens) {
  const resp = await post(url, key ? { Authorization: `Bearer ${key}` } : {}, {
    model,
    max_tokens: Math.max(maxTokens, MIN_TOKENS),
    messages: [{ role: 'user', content: prompt }],
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new ProviderError(`API di ${url} menolak permintaan (${resp.status}). ${body}`);
  }
  const data = await resp.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content?.trim();
  // finish_reason "length" with no text means the model spent the whole allowance thinking.
  if (!text) throw new ProviderError(`API di ${url} mengembalikan respons tanpa teks (finish_reason: ${choice?.finish_reason})`);
  return text;
}

async function callOpenAi(prompt, maxTokens) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ProviderError('OPENAI_API_KEY belum diatur di .env', 'unconfigured');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  return callOpenAiShaped('https://api.openai.com/v1/chat/completions', key, model, prompt, maxTokens);
}

// For any other provider that exposes an OpenAI-compatible chat endpoint.
async function callOpenAiCompatible(prompt, maxTokens) {
  const base = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL;
  const key = process.env.AI_API_KEY || '';
  if (!base || !model) {
    throw new ProviderError('AI_BASE_URL dan AI_MODEL wajib diisi di .env untuk AI_PROVIDER=openai_compatible', 'unconfigured');
  }
  return callOpenAiShaped(base, key, model, prompt, maxTokens);
}

/**
 * Generate text from whichever provider is configured.
 * @param {string} prompt
 * @param {{maxTokens?: number}} [opts]
 * @returns {Promise<string>}
 */
async function generateText(prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 400;
  const provider = providerName();
  if (provider === 'anthropic') return callAnthropic(prompt, maxTokens);
  if (provider === 'openai') return callOpenAi(prompt, maxTokens);
  if (provider === 'openai_compatible') return callOpenAiCompatible(prompt, maxTokens);
  throw new ProviderError(`AI_PROVIDER "${provider}" tidak dikenal. Pakai anthropic, openai, atau openai_compatible.`, 'unconfigured');
}

module.exports = { generateText, providerInfo, ProviderError };
