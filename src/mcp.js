#!/usr/bin/env node
// Stdio server entry point, launched by an MCP host. No task CLI is exposed.
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { serve } from './server.js';
import { metadata } from './metadata.js';

try {
  const { values } = parseArgs({ options: {
    config: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: strata-coder --config /absolute/path/strata-coder.config.json\nStarts an MCP stdio server; tasks are submitted through MCP tools.\nConfiguration: --config, STRATA_CODER_CONFIG, or legacy LOCAL_CODER_CONFIG.');
  } else if (values.version) {
    console.log(`${metadata.name} ${metadata.version}`);
  } else {
    await serve(loadConfig(values.config || process.env.STRATA_CODER_CONFIG || process.env.LOCAL_CODER_CONFIG));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
