// Pure planning helpers for the `strata-coder init` command.
// No file system access and no dependencies beyond node builtins.

const CHECK_NAME = 'strata_unit';
const CHECK_TIMEOUT_SECONDS = 300;

// Parse a command string into argv without any shell interpretation or expansion.
export function splitCommandLine(text) {
  if (typeof text !== 'string') throw new Error('Command line must be a string.');

  const tokens = [];
  let current = '';
  let started = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      index += 1;
      continue;
    }

    if (char === '\\') {
      if (index + 1 >= text.length) throw new Error('Command line ends with an unfinished escape.');
      started = true;
      current += text[index + 1];
      index += 2;
      continue;
    }

    if (char === "'") {
      started = true;
      index += 1;
      while (index < text.length && text[index] !== "'") {
        current += text[index];
        index += 1;
      }
      if (index >= text.length) throw new Error('Unterminated single quote in command line.');
      index += 1;
      continue;
    }

    if (char === '"') {
      started = true;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') {
          if (index + 1 >= text.length) throw new Error('Unterminated escape inside a double-quoted token.');
          current += text[index + 1];
          index += 2;
          continue;
        }
        current += text[index];
        index += 1;
      }
      if (index >= text.length) throw new Error('Unterminated double quote in command line.');
      index += 1;
      continue;
    }

    started = true;
    current += char;
    index += 1;
  }

  if (started) tokens.push(current);
  return tokens;
}

export function isPlaceholderTestScript(script) {
  if (typeof script !== 'string' || script.length === 0) return true;
  const trimmed = script.trim();
  if (trimmed === 'exit 1') return true;
  return /no test specified/i.test(trimmed);
}

export function detectNpmCheck({ projectRoot, packageJson, helperPath, nodePath }) {
  // projectRoot is informational only; the command never embeds a shell string.
  void projectRoot;
  const base = { name: CHECK_NAME, timeoutSeconds: CHECK_TIMEOUT_SECONDS };

  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    return { detected: false, reason: 'no package.json', script: null, ...base, command: null };
  }

  const script = packageJson.scripts?.test;
  if (typeof script !== 'string') {
    return { detected: false, reason: 'no test script', script: null, ...base, command: null };
  }
  if (isPlaceholderTestScript(script)) {
    return { detected: false, reason: 'placeholder test script', script: null, ...base, command: null };
  }

  return {
    detected: true,
    reason: null,
    script,
    ...base,
    command: [nodePath, helperPath, '--', 'npm', 'test'],
  };
}

export function buildProjectConfig({ baseUrl, model, apiKeyEnv, check, existing = {} }) {
  const config = {
    stateDir: 'state', checks: {}, defaultChecks: [], requireChecks: true,
    reasoningEffort: 'low', maxOutputTokens: 13000,
    ...existing, baseUrl, model, apiKeyEnv,
  };
  // init removes the retired field; all unrelated user settings survive.
  delete config.workspaceRoots;
  if (check) {
    config.checks = { ...config.checks, [check.name]: { command: check.command, timeoutSeconds: check.timeoutSeconds } };
    config.defaultChecks = [...new Set([...config.defaultChecks, check.name])];
  }
  return config;
}

export function validateBaseUrl(value) {
  if (typeof value !== 'string') throw new Error('baseUrl must be a string.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('baseUrl must be an http(s) endpoint without credentials, query or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function buildServerCommand({ nodePath, mcpEntry, configPath }) {
  return [nodePath, mcpEntry, '--config', configPath];
}

export function buildGenericStdioConfig({ serverCommand }) {
  return {
    mcpServers: {
      strata_coder: { command: serverCommand[0], args: serverCommand.slice(1) },
    },
  };
}

export function renderCollaborationRules(template, { projectRoot, configPath, checkName, collaborationRules = '' }) {
  if (typeof template !== 'string') throw new Error('Collaboration rules template must be a string.');
  return template
    .replaceAll('{{COLLABORATION_RULES}}', collaborationRules.trim())
    .replaceAll('{{PROJECT_ROOT}}', projectRoot)
    .replaceAll('{{CONFIG_PATH}}', configPath)
    .replaceAll('{{CHECK_NAME}}', checkName || '（尚未配置）');
}

export function renderAgentsReference() {
  return [
    '<!-- strata-coder:start -->',
    '## 本地编码模型协作（Strata Coder）',
    '',
    '在委派本地编码模型之前，请先阅读 `.opencode/strata-coder.md`。规划、评审与集成工作仍由主模型负责；当用户明确要求使用主模型时，不要委派任务。',
    '<!-- strata-coder:end -->',
  ].join('\n');
}

export function renderGitignoreBlock() {
  return [
    '# strata-coder:start',
    '.strata-coder/',
    '# strata-coder:end',
  ].join('\n');
}
