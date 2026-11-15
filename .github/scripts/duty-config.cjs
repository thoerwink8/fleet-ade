// SWE-2 duty config. Addresses and the model name come from the environment.
// Never put a key in this file. France points MAGPIE_BASE_URL at 192.0.2.2:3425.
const DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1";
const DEFAULT_MODEL = "group/swe-pool";
const DEFAULT_LIMIT = 10;

const REPOS = ["thoerwink8/fleet-ade", "thoerwink8/other-repo"];

// Kind labels, one per issue. Colors and descriptions match other-repo.
const KIND_LABELS = [
  {
    name: "\u7f3a\u9677",
    color: "f9d0c4",
    description:
      "\u73b0\u6709\u7684\u4e1c\u897f\u4e0d\u5bf9\uff0c\u8981\u4fee\u3002AI \u5206\u8bca\u65f6\u8d34\uff0c\u4eba\u53ef\u4ee5\u6539",
  },
  {
    name: "\u9700\u6c42",
    color: "a2eeef",
    description:
      "\u8981\u65b0\u4e1c\u897f\u6216\u6539\u884c\u4e3a\u3002AI \u5206\u8bca\u65f6\u8d34\uff0c\u4eba\u53ef\u4ee5\u6539",
  },
  {
    name: "\u6742\u9879",
    color: "ededed",
    description:
      "\u6587\u6863\u3001\u6574\u7406\u3001\u5347\u7ea7\u4f9d\u8d56\u8fd9\u7c7b\uff0c\u4e0d\u6539\u884c\u4e3a\u3002AI \u5206\u8bca\u65f6\u8d34\uff0c\u4eba\u53ef\u4ee5\u6539",
  },
];

// Query axes copied from other-repo packages/conventions/src/labels.ts.
// They only filter; they do not dispatch, merge, or milestone.
const DOMAIN_VALUES = ["engine", "api", "mirasim"];
const NATURE_VALUES = ["bug", "perf", "process"];
const QUERY_LABELS = [
  {
    name: "\u57df:engine",
    color: "1D76DB",
    description:
      "\u67e5\u8be2\u8f74\u00b7\u57df\uff1a\u6cd5\u56fd\u5f15\u64ce\u3002\u53ea\u7528\u6765\u7b5b\u3002",
  },
  {
    name: "\u57df:api",
    color: "0E8A16",
    description:
      "\u67e5\u8be2\u8f74\u00b7\u57df\uff1a\u9a7e\u9a76\u8231\u540e\u7aef\u3002\u53ea\u7528\u6765\u7b5b\u3002",
  },
  {
    name: "\u57df:mirasim",
    color: "5319E7",
    description: "\u67e5\u8be2\u8f74\u00b7\u57df\uff1aMirasim\u3002\u53ea\u7528\u6765\u7b5b\u3002",
  },
  {
    name: "\u6027\u8d28:bug",
    color: "D73A4A",
    description:
      "\u67e5\u8be2\u8f74\u00b7\u6027\u8d28\uff1a\u51fa\u9519\u3002\u53ea\u7528\u6765\u7b5b\uff0c\u4e0d\u4ee3\u66ff\u300c\u7f3a\u9677\u300d\u3002",
  },
  {
    name: "\u6027\u8d28:perf",
    color: "FBCA04",
    description:
      "\u67e5\u8be2\u8f74\u00b7\u6027\u8d28\uff1a\u6027\u80fd\u3002\u53ea\u7528\u6765\u7b5b\u3002",
  },
  {
    name: "\u6027\u8d28:process",
    color: "0075CA",
    description:
      "\u67e5\u8be2\u8f74\u00b7\u6027\u8d28\uff1a\u6d41\u7a0b\u3002\u53ea\u7528\u6765\u7b5b\u3002",
  },
];

const DUTY_LABEL = "\u503c\u73ed:\u5df2\u5206\u62e3";
const DUTY_LABEL_COLOR = "c5def5";
const DUTY_LABEL_DESCRIPTION =
  "SWE-2 \u503c\u73ed\u5df2\u5206\u62e3\u3002\u518d\u8dd1\u8df3\u8fc7\uff0c\u4e0d\u91cd\u590d\u8bc4\u8bba\u3002";
const PROMOTE_DAYS = 3;

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function loadConfig(env, argv) {
  const args = argv ?? [];
  const dryRun = args.includes("--dry-run");
  let command = null;
  for (const arg of args) {
    if (arg === "triage" || arg === "retro") {
      if (command) throw new Error("pass one command: triage or retro");
      command = arg;
    } else if (arg !== "--dry-run") {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (!command) throw new Error("pass one command: triage or retro");
  const baseUrl = (env.MAGPIE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const apiKey = env.MAGPIE_API_KEY || "";
  if (!dryRun && !apiKey) {
    throw new Error("MAGPIE_API_KEY is required unless --dry-run");
  }
  return {
    command,
    dryRun,
    baseUrl,
    model: env.MAGPIE_MODEL || DEFAULT_MODEL,
    apiKey,
    limit: positiveInt(env.DUTY_LIMIT, DEFAULT_LIMIT),
    repos: REPOS,
    lessonsPath: "LESSONS.md",
    promoteDays: PROMOTE_DAYS,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_LIMIT,
  REPOS,
  KIND_LABELS,
  DOMAIN_VALUES,
  NATURE_VALUES,
  QUERY_LABELS,
  DUTY_LABEL,
  DUTY_LABEL_COLOR,
  DUTY_LABEL_DESCRIPTION,
  PROMOTE_DAYS,
  loadConfig,
};
