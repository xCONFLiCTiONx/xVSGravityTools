import * as vscode from 'vscode';
import { FileDiff } from './diffAnalyzer';

let ollamaSecretStorage: vscode.SecretStorage | undefined;
const OLLAMA_API_KEY_SECRET = 'smartCommit.ollamaApiKey';

export function setOllamaSecretStorage(storage: vscode.SecretStorage): void {
  ollamaSecretStorage = storage;
}

export interface OllamaSettings {
  url: string;
  model: string;
}

export interface OllamaCommitOptions {
  format?: string;
  includeScope?: boolean;
  includeBody?: boolean;
  emojiStyle?: 'gitmoji' | 'simple';
}

// Small budgets keep prompt processing fast on small CPU-only servers.
const MAX_PROMPT_DIFF_CHARS = 3200;
const MAX_LINE_CHARS = 120;
const MAX_FILE_LIST = 25;
let aiOutput: vscode.OutputChannel | undefined;
function getAiOutput(): vscode.OutputChannel {
  if (!aiOutput) aiOutput = vscode.window.createOutputChannel('xVSGravityTools: Smart Commit AI');
  return aiOutput;
}
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(map|min\.js|lock|png|jpg|jpeg|gif|ico|svg|vsix|zip)$|(^|\/)(build|dist|out|node_modules)\//i;

/** Read the user's saved Ollama endpoint and model name. Returns undefined unless both are set. */
export function getOllamaSettings(): OllamaSettings | undefined {
  const config = vscode.workspace.getConfiguration('smartCommit');
  const url = (config.get<string>('ollamaUrl', '') || '').trim().replace(/\/+$/, '');
  const model = (config.get<string>('ollamaModel', '') || '').trim();
  return url && model ? { url, model } : undefined;
}

function buildDiffText(fileDiffs: FileDiff[], maxDiffChars = MAX_PROMPT_DIFF_CHARS): string {
  const files = fileDiffs.map(f => ({ f, name: f.newPath || f.oldPath }));
  const list = files.slice(0, MAX_FILE_LIST).map(({ f, name }) => `${f.status} ${name} (+${f.addedLines.length}/-${f.deletedLines.length})`);
  if (files.length > MAX_FILE_LIST) list.push(`...and ${files.length - MAX_FILE_LIST} more files`);

  // Prioritize meaningful files with the most changes first
  const meaningful = files.filter(({ name }) => !SKIP_FILE.test(name)).sort((a, b) =>
    (b.f.addedLines.length + b.f.deletedLines.length) - (a.f.addedLines.length + a.f.deletedLines.length));
  const snippets: string[] = [];
  let remaining = maxDiffChars;
  meaningful.forEach(({ f, name }, i) => {
    const share = Math.max(150, Math.floor(remaining / (meaningful.length - i)));
    const lines = [...f.deletedLines.map(l => '-' + l), ...f.addedLines.map(l => '+' + l)]
      .map(l => l.trim().slice(0, MAX_LINE_CHARS))
      .filter(l => l.length > 2);
    let out = `## ${name}\n`;
    for (const l of lines) {
      if (out.length + l.length + 1 > share) break;
      out += l + '\n';
    }
    remaining -= out.length;
    snippets.push(out);
  });
  return `Files changed:\n${list.join('\n')}\n\nKey changes:\n${snippets.join('')}`;
}

function cleanMessage(raw: string): string {
  let text = raw.trim();
  // Strip code blocks like ```markdown or ```gitcommit or just ```
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z0-9_-]*\r?\n/, '');
    text = text.replace(/\r?\n```\s*$/, '');
    text = text.trim();
  }
  // Strip quotes wrapping the whole response
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
  return text;
}

/**
 * Ask the configured Ollama server for a commit message adhering to user settings.
 * Returns undefined if not configured or on any failure so callers can fall back.
 */
export async function generateWithOllama(
  fileDiffs: FileDiff[],
  options: OllamaCommitOptions = {},
  fallbackBody?: string,
  timeoutMs = 60000,
): Promise<string | undefined> {
  const settings = getOllamaSettings();
  if (!settings) {
    getAiOutput().appendLine('[Smart Commit] Ollama is not configured; using the built-in generator.');
    return undefined;
  }
  getAiOutput().appendLine(`[Smart Commit] Requesting commit message from ${settings.model} at ${settings.url}.`);

  const withBody = !!(options.includeBody || options.format === 'detailed');
  const format = options.format || 'conventional';
  const includeScope = options.includeScope ?? true;
  const emojiStyle = options.emojiStyle || 'gitmoji';

  let styleInstruction = '';
  switch (format) {
    case 'emoji': {
      const emojiDesc = emojiStyle === 'simple'
        ? 'a simple emoji (e.g. 🚀 for feat, 🛠️ for fix/refactor, 🧹 for chore/cleanup, 🎨 for UI/style, 🧪 for test)'
        : 'an appropriate Gitmoji (e.g. ✨ for new feature, 🐛 for bugfix, 💄 for UI/style, ♻️ for refactor, 🔧 for tooling/config, 📝 for docs, 📦 for build/deps)';
      styleInstruction = `Subject line MUST start with ${emojiDesc}, followed by a concise imperative description.`;
      break;
    }
    case 'simple': {
      styleInstruction = 'Subject line MUST be a single plain imperative sentence starting with a capital letter, with no type/scope prefix and no emoji (e.g. "Add icons and dark title bar support").';
      break;
    }
    case 'detailed':
    case 'conventional':
    default: {
      const scopeDesc = includeScope ? 'type(scope): subject (e.g. feat(ui): add dark title bar support)' : 'type: subject (e.g. feat: add dark title bar support)';
      styleInstruction = `Subject line MUST follow Conventional Commits format: ${scopeDesc}. Valid types: feat, fix, refactor, style, docs, test, chore, perf, build.`;
      break;
    }
  }

  let structureInstruction = '';
  if (withBody) {
    structureInstruction = 'OUTPUT FORMAT REQUIREMENTS (MULTIPLE LINES REQUIRED):\n' + 'Line 1: Subject line (under 72 characters).\n' + 'Line 2: Blank line.\n' + 'Line 3+: Bullet points summarizing the main changes (2 to 6 concise bullet points, each starting with "- ").';
  } else {
    structureInstruction = 'OUTPUT FORMAT REQUIREMENTS:\n' + 'Output ONLY a single subject line under 72 characters. Do NOT include a blank line or any bullet points.';
  }

  const prompt =
    'You are an expert developer writing a Git commit message based on the changes below.\n' +
    'Output ONLY the raw commit message text. Do NOT wrap in markdown code blocks (no ```). Do not include any greeting, preamble, notes, or explanations.\n\n' +
    'RULES:\n' +
    `1. ${styleInstruction}\n` +
    `2. ${structureInstruction}\n` +
    '3. Describe only the code changes visible in the diff. Never advertise, market, promote, or pitch the project or its features.\n' +
    '4. Do not use phrases such as "Add AI-powered", "introducing", "now featuring", "powerful", "seamless", "unlock", "experience", or "for Windows desktop" unless those exact words are necessary to describe a literal code change.\n' +
    '5. Use a short, factual developer commit subject. Do not write release notes, product descriptions, slogans, announcements, or marketing copy.\n' +
    '6. If the diff does not support a specific claim, omit that claim. Never infer features from filenames or project context alone.\n\n' +
    buildDiffText(fileDiffs);
  const apiKey = await ollamaSecretStorage?.get(OLLAMA_API_KEY_SECRET);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const apiBase = settings.url.endsWith('/v1') ? settings.url : settings.url + '/v1';
    const res = await fetch(apiBase + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], stream: false }),
      signal: controller.signal
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${errorBody ? `: ${errorBody.slice(0, 500)}` : ''}`);
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string | null } }>; usage?: { completion_tokens?: number }; error?: { message?: string } };
    if (data.error) throw new Error(`Inference gateway: ${data.error.message || 'Unknown error'}`);
    let message = cleanMessage(data.choices?.[0]?.message?.content || '');
    if (!message) {
      const reason = 'Ollama returned an empty response.';
      getAiOutput().appendLine(`[ERROR] ${reason} Using the built-in generator.`);
      return undefined;
    }
    getAiOutput().appendLine(`[OK] Inference endpoint returned a commit message (${data.usage?.completion_tokens ?? 'unknown'} generated tokens).`);

    if (withBody) {
      const lines = message.split(/\r?\n/);
      if (lines.length > 1) {
        // Ensure there is a blank line separating subject and body
        if (lines[1].trim().length > 0) {
          lines.splice(1, 0, '');
          message = lines.join('\n');
        }
      } else if (fallbackBody) {
        // Model produced a single line despite instructions; append fallback body
        message = `${message}\n\n${fallbackBody}`;
      }
    } else {
      // If single line was requested, enforce only taking the first line
      message = message.split(/\r?\n/)[0].trim();
    }

    return message || undefined;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    getAiOutput().appendLine(`[ERROR] Ollama request failed: ${reason}. Using the built-in generator.`);
    vscode.window.setStatusBarMessage(`Smart Commit: Ollama unavailable (${reason}); using built-in generator.`, 5000);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
