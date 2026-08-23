import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { PROVIDERS, getProvider, listProviders, needsKey, normalizeBaseUrl } from '../agent/providers.js';
import {
  clearStored, configPath, describeConfig, maskKey, readStored, resolveConfig,
  testConfig, writeStored,
} from '../agent/config.js';
import { estimateCost, ZERO_USAGE } from '../agent/llm.js';

function tmpHome(): NodeJS.ProcessEnv {
  return { MCAI_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-cfg-')) } as NodeJS.ProcessEnv;
}
function cleanup(env: NodeJS.ProcessEnv) {
  fs.rmSync(env.MCAI_HOME!, { recursive: true, force: true });
}

// ── Catalogue ─────────────────────────────────────────────────────────────

test('every provider is complete enough to configure', () => {
  assert.ok(PROVIDERS.length >= 12, `only ${PROVIDERS.length} providers`);
  const ids = new Set<string>();
  for (const p of PROVIDERS) {
    assert.ok(!ids.has(p.id), `duplicate provider id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.name, `${p.id} has no name`);
    assert.ok(p.wire === 'anthropic' || p.wire === 'openai', `${p.id} has an unknown wire format`);
    if (p.id !== 'custom') {
      assert.ok(p.baseUrl.startsWith('http'), `${p.id} has no base url`);
      assert.ok(p.defaultModel, `${p.id} has no default model`);
      assert.ok(p.models.includes(p.defaultModel), `${p.id}: the default model is not in its own list`);
    }
    if (needsKey(p)) assert.ok(p.keyUrl.startsWith('http'), `${p.id} needs a key but says nowhere to get one`);
  }
});

test('base urls are stored without a version path', () => {
  // The adapter appends /v1/..., so a stored /v1 produces /v1/v1.
  for (const p of PROVIDERS) {
    assert.ok(!p.baseUrl.endsWith('/v1'), `${p.id} base url ends in /v1`);
    assert.ok(!p.baseUrl.endsWith('/'), `${p.id} base url has a trailing slash`);
  }
  assert.equal(normalizeBaseUrl('http://x:11434/v1/'), 'http://x:11434');
  assert.equal(normalizeBaseUrl('  https://api.openai.com  '), 'https://api.openai.com');
});

test('local providers need no key, hosted ones do', () => {
  assert.equal(needsKey(getProvider('ollama')!), false);
  assert.equal(needsKey(getProvider('lmstudio')!), false);
  assert.equal(needsKey(getProvider('anthropic')!), true);
  assert.equal(needsKey(getProvider('openai')!), true);
});

test('listProviders exposes no environment variable names', () => {
  const listed = listProviders();
  assert.equal(listed.length, PROVIDERS.length);
  for (const p of listed) assert.equal('envKeys' in p, false);
  assert.ok(listed.every((p) => typeof p.needsKey === 'boolean'));
});

test('getProvider is case-insensitive and safe on junk', () => {
  assert.equal(getProvider('ANTHROPIC')?.id, 'anthropic');
  assert.equal(getProvider('nope'), undefined);
  assert.equal(getProvider(''), undefined);
});

// ── Storage ───────────────────────────────────────────────────────────────

test('a saved config round-trips', () => {
  const env = tmpHome();
  assert.equal(readStored(env), null);
  writeStored({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-test' }, env);
  const back = readStored(env);
  assert.equal(back?.provider, 'openai');
  assert.equal(back?.apiKey, 'sk-test');
  assert.ok(back?.updatedAt, 'a timestamp is recorded');
  cleanup(env);
});

test('the config file is readable only by its owner', () => {
  const env = tmpHome();
  writeStored({ provider: 'openai', model: 'x', apiKey: 'sk-secret' }, env);
  const mode = fs.statSync(configPath(env)).mode & 0o777;
  assert.equal(mode, 0o600, `mode is ${mode.toString(8)} — an API key must not be world-readable`);
  cleanup(env);
});

test('a corrupt config file is ignored rather than fatal', () => {
  const env = tmpHome();
  fs.mkdirSync(env.MCAI_HOME!, { recursive: true });
  fs.writeFileSync(configPath(env), '{ not json');
  assert.equal(readStored(env), null);
  assert.equal(resolveConfig(env), null);
  cleanup(env);
});

test('clearStored removes the file and reports whether it did', () => {
  const env = tmpHome();
  assert.equal(clearStored(env), false);
  writeStored({ provider: 'groq', model: 'x', apiKey: 'k' }, env);
  assert.equal(clearStored(env), true);
  assert.equal(readStored(env), null);
  cleanup(env);
});

// ── Resolution ────────────────────────────────────────────────────────────

test('nothing configured resolves to null, which is a supported state', () => {
  const env = tmpHome();
  assert.equal(resolveConfig(env), null);
  assert.equal(describeConfig(env).configured, false);
  cleanup(env);
});

test('a vendor key in the environment is picked up without any setup', () => {
  const env = { ...tmpHome(), ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv;
  const c = resolveConfig(env);
  assert.equal(c?.providerId, 'anthropic');
  assert.equal(c?.provider, 'anthropic');
  assert.equal(c?.apiKey, 'sk-ant-x');
  assert.equal(c?.source, 'env');
  cleanup(env);
});

test('the environment beats the saved file', () => {
  const env = tmpHome();
  writeStored({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-file' }, env);
  assert.equal(resolveConfig(env)?.apiKey, 'sk-file');

  const withEnv = { ...env, GROQ_API_KEY: 'gsk-env' } as NodeJS.ProcessEnv;
  const c = resolveConfig(withEnv);
  assert.equal(c?.providerId, 'groq', 'an exported key must win, so Docker and CI keep working');
  assert.equal(c?.source, 'env');
  cleanup(env);
});

test('MCAI_PROVIDER overrides everything', () => {
  const env = {
    ...tmpHome(),
    ANTHROPIC_API_KEY: 'ignored',
    MCAI_PROVIDER: 'deepseek', MCAI_API_KEY: 'sk-ds', MCAI_MODEL: 'deepseek-reasoner',
  } as NodeJS.ProcessEnv;
  const c = resolveConfig(env);
  assert.equal(c?.providerId, 'deepseek');
  assert.equal(c?.model, 'deepseek-reasoner');
  assert.equal(c?.source, 'explicit');
  cleanup(env);
});

test('OLLAMA_HOST is treated as an address, not as a key', () => {
  const env = { ...tmpHome(), OLLAMA_HOST: 'http://box:11434/v1' } as NodeJS.ProcessEnv;
  const c = resolveConfig(env);
  assert.equal(c?.providerId, 'ollama');
  assert.equal(c?.baseUrl, 'http://box:11434', 'the adapter appends /v1 itself');
  assert.equal(c?.apiKey, 'not-needed');
  cleanup(env);
});

test('a saved local provider needs no key', () => {
  const env = tmpHome();
  writeStored({ provider: 'ollama', model: 'qwen2.5-coder:14b', baseUrl: 'http://127.0.0.1:11434' }, env);
  const c = resolveConfig(env);
  assert.equal(c?.apiKey, 'not-needed');
  assert.equal(describeConfig(env).local, true);
  cleanup(env);
});

test('describeConfig never returns the key', () => {
  const env = tmpHome();
  writeStored({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-verysecretvalue123' }, env);
  const d = describeConfig(env);
  assert.equal(JSON.stringify(d).includes('sk-verysecretvalue123'), false, 'the key must not leave the server');
  assert.match(d.configured ? d.keyMasked : '', /••••/);
  cleanup(env);
});

test('maskKey shows enough to recognise a key and no more', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('not-needed'), '');
  assert.equal(maskKey('short'), '••••');
  const m = maskKey('sk-ant-api03-abcdefghijklmnop');
  assert.match(m, /^sk-ant••••mnop$/);
});

// ── Connection test ───────────────────────────────────────────────────────

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((r) => server.close(() => r())); }
}

test('testConfig reports success with a round-trip time', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'echo-1', choices: [{ message: { content: 'hi' } }] }));
  }, async (baseUrl) => {
    const r = await testConfig({ provider: 'openai', model: 'echo-1', apiKey: 'k', baseUrl });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.model, 'echo-1');
    assert.ok(typeof r.ms === 'number');
  });
});

test('testConfig calls the right path for each wire format', async () => {
  const seen: string[] = [];
  await withServer((req, res) => {
    seen.push(`${req.url} ${req.headers['x-api-key'] ? 'x-api-key' : 'bearer'}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  }, async (baseUrl) => {
    await testConfig({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl });
    await testConfig({ provider: 'anthropic', model: 'm', apiKey: 'k', baseUrl });
  });
  assert.deepEqual(seen, ['/v1/chat/completions bearer', '/v1/messages x-api-key']);
});

test('testConfig explains a rejected key rather than dumping the response', async () => {
  await withServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  }, async (baseUrl) => {
    const r = await testConfig({ provider: 'openai', model: 'm', apiKey: 'bad', baseUrl });
    assert.equal(r.ok, false);
    assert.match(r.error!, /key was rejected/i);
  });
});

test('testConfig explains a missing model', async () => {
  await withServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model not found' } }));
  }, async (baseUrl) => {
    const r = await testConfig({ provider: 'openai', model: 'nope-9', apiKey: 'k', baseUrl });
    assert.equal(r.ok, false);
    assert.match(r.error!, /No such model "nope-9"/);
  });
});

test('testConfig explains an unreachable endpoint instead of throwing', async () => {
  // Port 1 is reserved and refuses connections.
  const r = await testConfig({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://127.0.0.1:1' }, 3000);
  assert.equal(r.ok, false);
  assert.match(r.error!, /Could not reach/);
});

test('testConfig gives up rather than hanging', async () => {
  await withServer(() => { /* never responds */ }, async (baseUrl) => {
    const r = await testConfig({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl }, 300);
    assert.equal(r.ok, false);
    assert.match(r.error!, /No response within/);
  });
});

// ── Cost ──────────────────────────────────────────────────────────────────

test('local models are reported as free, not guessed at', () => {
  const usage = { ...ZERO_USAGE, inputTokens: 1e6, outputTokens: 1e6 };
  assert.equal(estimateCost('qwen2.5-coder:14b', usage), 0);
  assert.equal(estimateCost('local-model', usage), 0);
  assert.ok(estimateCost('gpt-4.1-mini', usage) > 0);
});

test('the longest matching price key wins', () => {
  const usage = { ...ZERO_USAGE, inputTokens: 1e6 };
  const haiku = estimateCost('claude-haiku-4-5', usage);
  const opus = estimateCost('claude-opus-4-1', usage);
  assert.ok(haiku < opus, `haiku ${haiku} should be cheaper than opus ${opus}`);
  assert.ok(estimateCost('gpt-4.1-mini', usage) < estimateCost('gpt-4.1', usage));
});

test('every catalogue default model has a price', () => {
  const usage = { ...ZERO_USAGE, inputTokens: 1e6 };
  for (const p of PROVIDERS) {
    if (!p.defaultModel || p.local) continue;
    const cost = estimateCost(p.defaultModel, usage);
    assert.ok(cost > 0, `${p.id}: ${p.defaultModel} priced at zero`);
  }
});
