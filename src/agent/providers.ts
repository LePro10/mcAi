/**
 * The provider catalogue.
 *
 * mcAI is not tied to any one vendor and does not want your Claude login. You
 * pick a provider, paste a key, and it runs — or you point it at Ollama or LM
 * Studio and it runs with no key and no account at all.
 *
 * Nearly everything speaks one of two wire formats. Anthropic has its own;
 * everyone else, including Google's Gemini through its compatibility endpoint,
 * speaks the OpenAI chat-completions shape. So the catalogue is mostly a table
 * of base URLs and sensible default models rather than a pile of adapters.
 */

export type WireFormat = 'anthropic' | 'openai';

export interface ProviderDef {
  id: string;
  /** Shown in the picker. */
  name: string;
  wire: WireFormat;
  baseUrl: string;
  /** Environment variables checked, in order, before the saved config. */
  envKeys: string[];
  defaultModel: string;
  /** Known-good models, newest first. Free text is also accepted. */
  models: string[];
  /** Where to get a key. Empty for local providers. */
  keyUrl: string;
  /** Runs locally: no key, no account, no cost. */
  local?: boolean;
  /** One line shown under the provider in the picker. */
  note: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    wire: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    envKeys: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-3-5-haiku-latest'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Best blueprint quality. Prompt caching cuts repeat builds to a fraction.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    wire: 'openai',
    baseUrl: 'https://api.openai.com',
    envKeys: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Widely available. gpt-4.1-mini is the cheap default.',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    wire: 'openai',
    // Gemini's OpenAI-compatible endpoint, so no separate adapter is needed.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Generous free tier on AI Studio keys.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    wire: 'openai',
    baseUrl: 'https://openrouter.ai/api',
    envKeys: ['OPENROUTER_API_KEY'],
    defaultModel: 'anthropic/claude-sonnet-4.5',
    models: [
      'anthropic/claude-sonnet-4.5', 'openai/gpt-4.1-mini', 'google/gemini-2.5-flash',
      'deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b-instruct', 'qwen/qwen3-coder',
    ],
    keyUrl: 'https://openrouter.ai/keys',
    note: 'One key, every model. Easiest way to try several.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    wire: 'openai',
    baseUrl: 'https://api.deepseek.com',
    envKeys: ['DEEPSEEK_API_KEY'],
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: 'Very cheap and good enough for most builds.',
  },
  {
    id: 'groq',
    name: 'Groq',
    wire: 'openai',
    baseUrl: 'https://api.groq.com/openai',
    envKeys: ['GROQ_API_KEY'],
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct'],
    keyUrl: 'https://console.groq.com/keys',
    note: 'Fastest responses by a wide margin. Free tier available.',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    wire: 'openai',
    baseUrl: 'https://api.mistral.ai',
    envKeys: ['MISTRAL_API_KEY'],
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    note: 'European hosting.',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    wire: 'openai',
    baseUrl: 'https://api.x.ai',
    envKeys: ['XAI_API_KEY'],
    defaultModel: 'grok-4-fast',
    models: ['grok-4-fast', 'grok-4', 'grok-3-mini'],
    keyUrl: 'https://console.x.ai',
    note: '',
  },
  {
    id: 'together',
    name: 'Together AI',
    wire: 'openai',
    baseUrl: 'https://api.together.xyz',
    envKeys: ['TOGETHER_API_KEY'],
    defaultModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
    models: [
      'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3',
    ],
    keyUrl: 'https://api.together.ai/settings/api-keys',
    note: 'Open models, hosted.',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    wire: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference',
    envKeys: ['FIREWORKS_API_KEY'],
    defaultModel: 'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct',
    models: [
      'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct',
      'accounts/fireworks/models/deepseek-v3',
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
    ],
    keyUrl: 'https://fireworks.ai/account/api-keys',
    note: '',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    wire: 'openai',
    baseUrl: 'https://api.cerebras.ai',
    envKeys: ['CEREBRAS_API_KEY'],
    defaultModel: 'qwen-3-coder-480b',
    models: ['qwen-3-coder-480b', 'llama-3.3-70b'],
    keyUrl: 'https://cloud.cerebras.ai',
    note: 'Extremely fast. Free tier available.',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    wire: 'openai',
    baseUrl: 'http://127.0.0.1:11434',
    envKeys: ['OLLAMA_HOST'],
    defaultModel: 'qwen2.5-coder:14b',
    models: ['qwen2.5-coder:14b', 'qwen2.5-coder:32b', 'llama3.3:70b', 'mistral-small'],
    keyUrl: 'https://ollama.com/download',
    local: true,
    note: 'Runs on your machine. No key, no account, no cost.',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    wire: 'openai',
    baseUrl: 'http://127.0.0.1:1234',
    envKeys: ['LMSTUDIO_HOST'],
    defaultModel: 'local-model',
    models: ['local-model'],
    keyUrl: 'https://lmstudio.ai',
    local: true,
    note: 'Runs on your machine. Start its server, then pick the loaded model.',
  },
  {
    id: 'custom',
    name: 'Custom endpoint',
    wire: 'openai',
    baseUrl: '',
    envKeys: [],
    defaultModel: '',
    models: [],
    keyUrl: '',
    note: 'Anything speaking the OpenAI chat-completions API. Set the base URL yourself.',
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ProviderDef | undefined {
  return BY_ID.get(id?.toLowerCase?.() ?? '');
}

/** Local providers need no key; everything else does. */
export function needsKey(p: ProviderDef): boolean {
  return !p.local && p.id !== 'custom';
}

/**
 * The URL the OpenAI adapter should call. Base URLs are stored without the
 * version path so a user pasting `.../v1` by habit does not produce `/v1/v1`.
 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Catalogue trimmed for the picker: no secrets, no internals. */
export function listProviders(): Array<Omit<ProviderDef, 'envKeys'> & { needsKey: boolean }> {
  return PROVIDERS.map(({ envKeys, ...rest }) => ({ ...rest, needsKey: needsKey(rest as ProviderDef) }));
}
