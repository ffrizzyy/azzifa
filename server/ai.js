// One function, generateText(prompt), that hides which AI provider is actually being called.
// Swapping providers is a .env change (AI_PROVIDER=...), not a code change.
class ProviderError extends Error {}

async function callAnthropic(prompt, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ProviderError('ANTHROPIC_API_KEY belum diatur di server/.env');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error('Anthropic API error:', resp.status, body);
    throw new ProviderError(`Anthropic API menolak permintaan (${resp.status}) — cek ANTHROPIC_API_KEY`);
  }
  const data = await resp.json();
  const text = (data.content || []).map((b) => b.text || '').join('\n').trim();
  if (!text) throw new ProviderError('Anthropic API mengembalikan respons kosong');
  return text;
}

// Shared by OpenAI itself and anything that speaks the same /chat/completions shape
// (Groq, Together, Mistral, a local Ollama behind an OpenAI-compatible shim, etc.)
async function callOpenAiShaped(url, key, model, prompt, maxTokens) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error('AI provider error:', url, resp.status, body);
    throw new ProviderError(`API di ${url} menolak permintaan (${resp.status})`);
  }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new ProviderError(`API di ${url} mengembalikan respons yang tidak dikenali`);
  return text;
}

async function callOpenAi(prompt, maxTokens) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ProviderError('OPENAI_API_KEY belum diatur di server/.env');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  return callOpenAiShaped('https://api.openai.com/v1/chat/completions', key, model, prompt, maxTokens);
}

// For any other provider that exposes an OpenAI-compatible chat endpoint.
async function callOpenAiCompatible(prompt, maxTokens) {
  const base = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL;
  const key = process.env.AI_API_KEY || '';
  if (!base || !model) {
    throw new ProviderError('AI_BASE_URL dan AI_MODEL wajib diisi di .env untuk AI_PROVIDER=openai_compatible');
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
  const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  if (provider === 'anthropic') return callAnthropic(prompt, maxTokens);
  if (provider === 'openai') return callOpenAi(prompt, maxTokens);
  if (provider === 'openai_compatible') return callOpenAiCompatible(prompt, maxTokens);
  throw new ProviderError(`AI_PROVIDER "${provider}" tidak dikenal. Pakai anthropic, openai, atau openai_compatible.`);
}

module.exports = { generateText, ProviderError };
