#!/usr/bin/env node
// Read-only inspection of a retained parallel integration intent.
import { inspectIntegrationIntent } from "../lib/integration-intent.mjs";

if (process.argv.length !== 3) {
  process.stderr.write("Usage: node bin/inspect-integration.mjs <integration-intent.json>\n");
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${JSON.stringify(inspectIntegrationIntent(process.argv[2]), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Integration inspection failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
