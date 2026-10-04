#!/usr/bin/env node
// Entry point launched by an MCP host. `init` is the only CLI subcommand; any
// other invocation starts the stdio server.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, defaultConfigPath, projectConfigPath } from './config.js';
import { serve } from './server.js';
import { metadata } from './metadata.js';

const HELP = 'Usage: strata-coder init [--cwd DIR] [--baseUrl URL] [--model MODEL] [--apiKeyEnv NAME] [--check-command LINE] [--yes]\n'
  + '       strata-coder [--config /absolute/path/strata-coder.config.json] [--baseUrl URL] [--model MODEL] [--apiKeyEnv ENV_NAME]\n'
  + 'Run "strata-coder init --help" for the init options.\n'
  + 'Without the init subcommand this entry starts an MCP stdio server; tasks are submitted through MCP tools.\n'
  + 'Configuration: --config, STRATA_CODER_CONFIG, or legacy LOCAL_CODER_CONFIG; when none is set, .strata-coder/config.json of the current project is used, then strata-coder.config.json, then local-coder.config.json from the package root. Run "strata-coder init" in a project to create its config.\n'
  + 'Overrides: --baseUrl, --model and --apiKeyEnv replace the file values when provided.';

function existingFile(candidate) {
  return candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
}

try {
  if (process.argv[2] === 'init') {
    const { runInit } = await import('./init.js');
    process.exitCode = await runInit(process.argv.slice(3));
  } else {
    const { values } = parseArgs({ options: {
      config: { type: 'string' }, baseUrl: { type: 'string' }, model: { type: 'string' }, apiKeyEnv: { type: 'string' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    } });
    if (values.help) {
      console.log(HELP);
    } else if (values.version) {
      console.log(`${metadata.name} ${metadata.version}`);
    } else {
      const packageRoot = fileURLToPath(new URL('../', import.meta.url));
      const configPath = values.config || process.env.STRATA_CODER_CONFIG || process.env.LOCAL_CODER_CONFIG
        || existingFile(projectConfigPath(process.cwd())) || defaultConfigPath(packageRoot);
      if (!configPath) {
        throw new Error('No configuration found. Run "strata-coder init" in this project, or pass --config /absolute/path/strata-coder.config.json.');
      }
      await serve(loadConfig(configPath, { baseUrl: values.baseUrl, model: values.model, apiKeyEnv: values.apiKeyEnv }));
    }
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
