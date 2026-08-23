/**
 * `mcai setup` — pick a provider, paste a key, done.
 *
 * The point is that nobody has to read documentation to get past this step.
 * It shows what is already configured, lists every provider with what it costs
 * you, tests the choice against the real endpoint before saving it, and says
 * something useful when the test fails.
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { PROVIDERS, getProvider, needsKey, normalizeBaseUrl } from '../agent/providers.js';
import { clearStored, configPath, describeConfig, testConfig, writeStored } from '../agent/config.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export async function runSetup(argv: string[] = []): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    if (argv.includes('--clear')) {
      console.log(clearStored() ? C.green('\n  Cleared. mcAI will use library structures only.\n') : C.dim('\n  Nothing was saved.\n'));
      return;
    }

    console.log(`\n${C.bold('  mcAI setup')}`);
    console.log(C.dim(`  Saved to ${configPath()}\n`));

    const current = describeConfig();
    if (current.configured) {
      console.log(`  Currently: ${C.cyan(current.providerName)} · ${current.model}` +
        (current.keyMasked ? ` · ${C.dim(current.keyMasked)}` : '') +
        C.dim(current.source === 'env' ? '  (from the environment)' : ''));
      if (current.source === 'env') {
        console.log(C.yellow('  An environment variable is set and will win over anything saved here.'));
      }
      console.log();
    }

    // ── Provider ──
    console.log(C.bold('  Providers\n'));
    PROVIDERS.forEach((p, i) => {
      const tag = p.local ? C.green('free, local') : p.id === 'custom' ? C.dim('advanced') : '';
      console.log(`  ${String(i + 1).padStart(2)}. ${C.cyan(p.name.padEnd(16))}${tag}`);
      if (p.note) console.log(`      ${C.dim(p.note)}`);
    });

    const pick = await ask(rl, `\n  Number (1-${PROVIDERS.length}), or blank to cancel: `);
    if (!pick) { console.log(C.dim('\n  Cancelled.\n')); return; }
    const provider = PROVIDERS[Number(pick) - 1] ?? getProvider(pick);
    if (!provider) { console.log(C.red(`\n  "${pick}" is not one of the options.\n`)); return; }

    console.log(`\n  ${C.bold(provider.name)}`);

    // ── Base URL ──
    let baseUrl = provider.baseUrl;
    if (provider.id === 'custom' || provider.local) {
      const prompt = provider.id === 'custom'
        ? '  Base URL (OpenAI-compatible, without /v1): '
        : `  Base URL [${provider.baseUrl}]: `;
      baseUrl = normalizeBaseUrl((await ask(rl, prompt)) || provider.baseUrl);
      if (!baseUrl) { console.log(C.red('\n  A base URL is required.\n')); return; }
    }

    // ── Key ──
    let apiKey = '';
    if (needsKey(provider)) {
      if (provider.keyUrl) console.log(C.dim(`  Get a key: ${provider.keyUrl}`));
      apiKey = await askSecret(rl, '  API key: ');
      if (!apiKey) { console.log(C.red('\n  No key entered.\n')); return; }
    } else if (provider.id === 'custom') {
      apiKey = await askSecret(rl, '  API key (blank if none): ');
    }

    // ── Model ──
    if (provider.models.length) {
      console.log(`\n  ${C.dim('Models')}`);
      provider.models.forEach((m, i) => {
        console.log(`  ${String(i + 1).padStart(2)}. ${m}${i === 0 ? C.dim('  (recommended)') : ''}`);
      });
    }
    const modelInput = await ask(rl, `\n  Model [${provider.defaultModel || 'required'}]: `);
    const model = modelInput
      ? (provider.models[Number(modelInput) - 1] ?? modelInput)
      : provider.defaultModel;
    if (!model) { console.log(C.red('\n  A model name is required.\n')); return; }

    // ── Test, then save ──
    const config = { provider: provider.wire, model, apiKey: apiKey || 'not-needed', baseUrl };
    stdout.write(`\n  Testing ${provider.name} · ${model} … `);
    const result = await testConfig(config);

    if (!result.ok) {
      console.log(C.red('failed'));
      console.log(`\n  ${result.error}\n`);
      if (provider.local) {
        console.log(C.dim(`  Is ${provider.name} running? Start it, then run "mcai setup" again.\n`));
      }
      const save = await ask(rl, '  Save anyway? [y/N]: ');
      if (save.toLowerCase() !== 'y') { console.log(C.dim('\n  Not saved.\n')); return; }
    } else {
      console.log(C.green(`ok`) + C.dim(` (${result.ms}ms)`));
    }

    const file = writeStored({
      provider: provider.id,
      model,
      apiKey: apiKey || undefined,
      baseUrl,
    });

    console.log(C.green(`\n  Saved to ${file}`));
    console.log(C.dim('  The file is readable only by you.\n'));
    console.log('  Next:');
    console.log(`    ${C.cyan('mcai serve --sim')}   ${C.dim('try it with no Minecraft server')}`);
    console.log(`    ${C.cyan('mcai serve')}         ${C.dim('connect to your server (needs RCON_PASSWORD)')}\n`);
  } finally {
    rl.close();
  }
}

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

/**
 * Read a secret without echoing it.
 *
 * An API key pasted into a terminal ends up in scrollback and, depending on
 * the shell, in history. Falls back to a visible prompt when stdin is not a
 * TTY, so piping still works.
 */
async function askSecret(rl: readline.Interface, prompt: string): Promise<string> {
  if (!stdin.isTTY) return ask(rl, prompt);

  const rlAny = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
  const original = rlAny._writeToOutput;
  let masking = false;

  rlAny._writeToOutput = (chunk: string) => {
    if (!masking) { rlAny.output.write(chunk); return; }
    // Keep the prompt visible, replace the typed characters.
    if (chunk.includes(prompt)) rlAny.output.write(prompt);
    else if (chunk === '\r\n' || chunk === '\n') rlAny.output.write(chunk);
    else rlAny.output.write('•');
  };

  masking = true;
  const answer = await rl.question(prompt);
  masking = false;
  rlAny._writeToOutput = original;
  stdout.write('\n');
  return answer.trim();
}
