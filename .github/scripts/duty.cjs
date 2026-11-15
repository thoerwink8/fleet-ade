#!/usr/bin/env node
// SWE-2 duty: `triage` and `retro`, both read-only toward code and rules; --dry-run writes nothing.
// Config comes from the environment (MAGPIE_BASE_URL, MAGPIE_MODEL, MAGPIE_API_KEY, DUTY_LIMIT).
// Cron setup is in docs/operations/swe-duty.md; this command does not install it.
const fs = require("node:fs");
const path = require("node:path");

const { loadConfig } = require("./duty-config.cjs");
const { runTriage } = require("./duty-triage.cjs");
const { runRetro } = require("./duty-retro.cjs");
const github = require("./duty-github.cjs");

function lessonsFile(root, lessonsPath) {
  const file = path.join(root, lessonsPath);
  return {
    readLessons: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""),
    writeLessons: (_ignored, text) => {
      fs.writeFileSync(file, text);
    },
  };
}

async function main(argv, env, io) {
  const cfg = loadConfig(env, argv);
  const log = io.log;
  if (cfg.command === "triage") {
    await runTriage({ config: cfg, github, log });
    return;
  }
  const day = env.DUTY_DAY || new Date().toISOString().slice(0, 10);
  await runRetro({
    config: cfg,
    github,
    fs: lessonsFile(io.root, cfg.lessonsPath),
    day,
    log,
  });
}

if (require.main === module) {
  main(process.argv.slice(2), process.env, {
    log: (line) => process.stdout.write(`${line}\n`),
    root: path.resolve(__dirname, "../.."),
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, lessonsFile };
