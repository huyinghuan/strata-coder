import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCommandLine,
  isPlaceholderTestScript,
  detectNpmCheck,
  buildProjectConfig,
  validateBaseUrl,
  buildServerCommand,
  buildGenericStdioConfig,
  renderCollaborationRules,
  renderAgentsReference,
  renderGitignoreBlock,
} from '../src/init-plan.js';

test('splitCommandLine splits plain words and keeps flags', () => {
  assert.deepEqual(splitCommandLine('npm test'), ['npm', 'test']);
  assert.deepEqual(splitCommandLine('pytest -q'), ['pytest', '-q']);
});

test('splitCommandLine keeps spaces inside double quotes and escapes inside them', () => {
  assert.deepEqual(splitCommandLine('node --test "my tests/x.js"'), ['node', '--test', 'my tests/x.js']);
  assert.deepEqual(splitCommandLine('echo "say \\"hi\\""'), ['echo', 'say "hi"']);
  assert.deepEqual(splitCommandLine('echo "tab\\tend"'), ['echo', 'tabtend']);
});

test('splitCommandLine keeps everything literal inside single quotes', () => {
  assert.deepEqual(splitCommandLine("echo 'a b' -n"), ['echo', 'a b', '-n']);
  assert.deepEqual(splitCommandLine("echo 'a\\b'"), ['echo', 'a\\b']);
});

test('splitCommandLine escapes outside quotes and produces empty tokens from empty quotes', () => {
  assert.deepEqual(splitCommandLine('a\\ b'), ['a b']);
  assert.deepEqual(splitCommandLine("echo ''"), ['echo', '']);
  assert.deepEqual(splitCommandLine('echo "" x'), ['echo', '', 'x']);
  assert.deepEqual(splitCommandLine("'' ''"), ['', '']);
});

test('splitCommandLine ignores leading, repeated and trailing whitespace', () => {
  assert.deepEqual(splitCommandLine('  npm   test  '), ['npm', 'test']);
  assert.deepEqual(splitCommandLine('\tnpm\ttest\t'), ['npm', 'test']);
  assert.deepEqual(splitCommandLine('   '), []);
  assert.deepEqual(splitCommandLine(''), []);
});

test('splitCommandLine rejects unterminated quotes and dangling escapes', () => {
  assert.throws(() => splitCommandLine("echo 'oops"), /Unterminated single quote/);
  assert.throws(() => splitCommandLine('echo "oops'), /Unterminated double quote/);
  assert.throws(() => splitCommandLine('echo "oops\\'), /Unterminated escape/);
  assert.throws(() => splitCommandLine('echo a\\'), /unfinished escape/);
  assert.throws(() => splitCommandLine(null), /must be a string/);
});

test('isPlaceholderTestScript detects placeholders and empty values', () => {
  assert.equal(isPlaceholderTestScript('exit 1'), true);
  assert.equal(isPlaceholderTestScript('  exit 1  '), true);
  assert.equal(isPlaceholderTestScript('echo "Error: no test specified" && exit 1'), true);
  assert.equal(isPlaceholderTestScript('NO TEST SPECIFIED'), true);
  assert.equal(isPlaceholderTestScript(''), true);
  assert.equal(isPlaceholderTestScript(null), true);
  assert.equal(isPlaceholderTestScript(undefined), true);
  assert.equal(isPlaceholderTestScript(42), true);
});

test('isPlaceholderTestScript accepts real test scripts', () => {
  assert.equal(isPlaceholderTestScript('node --test test/*.test.js'), false);
  assert.equal(isPlaceholderTestScript('exit 10'), false);
  assert.equal(isPlaceholderTestScript('npm run test:unit'), false);
});

test('detectNpmCheck builds a helper-based command for a real test script', () => {
  const check = detectNpmCheck({
    projectRoot: '/tmp/project',
    packageJson: { name: 'demo', scripts: { test: 'node --test test/*.test.js' } },
    helperPath: '/tmp/helper.js',
    nodePath: process.execPath,
  });
  assert.equal(check.detected, true);
  assert.equal(check.reason, null);
  assert.equal(check.script, 'node --test test/*.test.js');
  assert.equal(check.name, 'strata_unit');
  assert.equal(check.timeoutSeconds, 300);
  assert.deepEqual(check.command, [process.execPath, '/tmp/helper.js', '--', 'npm', 'test']);
  assert.ok(!check.command.some(part => part.includes('&&') || part.includes('|')));
});

test('detectNpmCheck classifies placeholder, missing and absent package.json', () => {
  const base = { nodePath: 'node', helperPath: 'helper.js', projectRoot: '/tmp/project' };

  const placeholder = detectNpmCheck({
    ...base,
    packageJson: { scripts: { test: 'echo "Error: no test specified" && exit 1' } },
  });
  assert.equal(placeholder.detected, false);
  assert.equal(placeholder.reason, 'placeholder test script');
  assert.equal(placeholder.script, null);
  assert.equal(placeholder.command, null);
  assert.equal(placeholder.name, 'strata_unit');
  assert.equal(placeholder.timeoutSeconds, 300);

  const missingScript = detectNpmCheck({ ...base, packageJson: { scripts: {} } });
  assert.equal(missingScript.detected, false);
  assert.equal(missingScript.reason, 'no test script');

  const missingScriptsObject = detectNpmCheck({ ...base, packageJson: { name: 'demo' } });
  assert.equal(missingScriptsObject.reason, 'no test script');

  assert.equal(detectNpmCheck({ ...base, packageJson: null }).reason, 'no package.json');
  assert.equal(detectNpmCheck({ ...base, packageJson: undefined }).reason, 'no package.json');
  assert.equal(detectNpmCheck({ ...base, packageJson: 'not-an-object' }).reason, 'no package.json');
});

test('buildProjectConfig keeps requireChecks and never stores directory whitelists', () => {
  const check = detectNpmCheck({
    projectRoot: '/srv/app',
    packageJson: { scripts: { test: 'node --test' } },
    helperPath: '/srv/helper.js',
    nodePath: 'node',
  });
  const config = buildProjectConfig({
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3-coder',
    apiKeyEnv: 'LOCAL_CODER_API_KEY',
    check,
  });
  assert.deepEqual(config, {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3-coder',
    apiKeyEnv: 'LOCAL_CODER_API_KEY',
    stateDir: 'state',
    checks: { strata_unit: { command: ['node', '/srv/helper.js', '--', 'npm', 'test'], timeoutSeconds: 300 } },
    defaultChecks: ['strata_unit'],
    requireChecks: true,
    reasoningEffort: 'low',
    maxOutputTokens: 13000,
  });
  assert.equal('workspaceRoots' in config, false);
  assert.equal(JSON.stringify(config).includes('sk-'), false);
  assert.equal(JSON.stringify(config).includes('example'), false);
});

test('buildProjectConfig with no check yields empty checks and defaultChecks', () => {
  const config = buildProjectConfig({
    baseUrl: 'https://api.example.com/v1',
    model: 'model-a',
    apiKeyEnv: 'STRATA_CODER_API_KEY',
    check: null,
  });
  assert.deepEqual(config.checks, {});
  assert.deepEqual(config.defaultChecks, []);
  assert.equal(config.requireChecks, true);
  assert.equal('workspaceRoots' in config, false);
  assert.equal(JSON.stringify(config).includes('sk-'), false);
});

test('validateBaseUrl normalizes trailing slashes', () => {
  assert.equal(validateBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(validateBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(validateBaseUrl('https://api.openai.com/v1///'), 'https://api.openai.com/v1');
});

test('validateBaseUrl rejects non-URLs, non-http protocols, credentials, query and fragment', () => {
  assert.throws(() => validateBaseUrl('not a url'), /not a valid URL/);
  assert.throws(() => validateBaseUrl(null), /must be a string/);
  assert.throws(() => validateBaseUrl(42), /must be a string/);
  assert.throws(() => validateBaseUrl('ftp://host.example/files'), /http\(s\)/);
  assert.throws(() => validateBaseUrl('https://user:pass@host.example/v1'), /credentials, query or fragment/);
  assert.throws(() => validateBaseUrl('https://host.example/v1?key=secret'), /credentials, query or fragment/);
  assert.throws(() => validateBaseUrl('https://host.example/v1#section'), /credentials, query or fragment/);
});

test('buildServerCommand and buildGenericStdioConfig keep argv as an array', () => {
  const serverCommand = buildServerCommand({
    nodePath: process.execPath,
    mcpEntry: '/repo/src/mcp.js',
    configPath: '/repo/strata-coder.config.json',
  });
  assert.deepEqual(serverCommand, [process.execPath, '/repo/src/mcp.js', '--config', '/repo/strata-coder.config.json']);

  const generic = buildGenericStdioConfig({ serverCommand });
  assert.deepEqual(generic, {
    mcpServers: {
      strata_coder: {
        command: process.execPath,
        args: ['/repo/src/mcp.js', '--config', '/repo/strata-coder.config.json'],
      },
    },
  });
  assert.equal(typeof generic.mcpServers.strata_coder.command, 'string');
  assert.ok(Array.isArray(generic.mcpServers.strata_coder.args));
});

test('renderCollaborationRules substitutes the documented placeholders', () => {
  const template = [
    'Project root: {{PROJECT_ROOT}}',
    'Config: {{CONFIG_PATH}}',
    'Check: {{CHECK_NAME}}',
    'Keep other content untouched.',
  ].join('\n');
  assert.equal(
    renderCollaborationRules(template, {
      projectRoot: '/srv/app',
      configPath: '/srv/app/strata-coder.config.json',
      checkName: 'strata_unit',
    }),
    [
      'Project root: /srv/app',
      'Config: /srv/app/strata-coder.config.json',
      'Check: strata_unit',
      'Keep other content untouched.',
    ].join('\n'),
  );
  assert.equal(
    renderCollaborationRules('check {{CHECK_NAME}} at {{PROJECT_ROOT}}', {
      projectRoot: '/srv/app',
      configPath: '/srv/app/state',
      checkName: '',
    }),
    'check （尚未配置） at /srv/app',
  );
  assert.equal(renderCollaborationRules('no placeholder here', { projectRoot: 'x', configPath: 'y', checkName: '' }), 'no placeholder here');
});

test('renderAgentsReference and renderGitignoreBlock produce stable marker blocks', () => {
  const agents = renderAgentsReference();
  const lines = agents.split('\n');
  assert.equal(lines[0], '<!-- strata-coder:start -->');
  assert.equal(lines[lines.length - 1], '<!-- strata-coder:end -->');
  assert.ok(agents.includes('## 本地编码模型协作（Strata Coder）'));
  assert.ok(agents.includes('.opencode/strata-coder.md'));
  assert.equal(renderAgentsReference(), agents);

  const gitignore = renderGitignoreBlock();
  assert.deepEqual(gitignore.split('\n'), ['# strata-coder:start', '.strata-coder/', '# strata-coder:end']);
  assert.equal(renderGitignoreBlock(), gitignore);
});
