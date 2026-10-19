#!/usr/bin/env node
import { runGateway } from "../src/gateway.mjs";
import { runRunner } from "../src/runner.mjs";
import { runMcp } from "../src/mcp.mjs";
import { cli } from "../src/cli.mjs";

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "gateway") {
    await runGateway(rest);
  } else if (command === "runner") {
    await runRunner(rest);
  } else if (command === "mcp") {
    await runMcp(rest);
  } else {
    await cli(command, rest);
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
