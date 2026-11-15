// Issue triage. Reads new issues, asks SWE-2 once each, and writes labels plus
// at most two comments. A second run skips anything already carrying the duty label.
const config = require("./duty-config.cjs");
const { complete } = require("./duty-model.cjs");

const MARKER = "<!-- duty:triage -->";
const DUPLICATE_MARKER = "<!-- duty:duplicate -->";
const CI_MARKER = "<!-- duty:ci -->";

const TRIAGE_SCHEMA = {
  valid: "boolean, false when the issue has no actionable request",
  kind: "one of \u7f3a\u9677, \u9700\u6c42, \u6742\u9879",
  domain: "one of engine, api, mirasim",
  nature: "one of bug, perf, process",
  duplicateOf: "issue number in the same repo, or null",
  ciCause: "one sentence root cause when the body is a long CI failure log, otherwise null",
};

function systemPrompt() {
  return [
    "You triage one GitHub issue for a private ADE repo.",
    "Reply with one JSON object and no other text.",
    `Fields: ${JSON.stringify(TRIAGE_SCHEMA)}`,
    "kind \u7f3a\u9677 = something that exists is wrong. \u9700\u6c42 = new behavior. \u6742\u9879 = docs, chores, dependency bumps.",
    "domain engine = the France engine. api = the cockpit backend. mirasim = Mirasim.",
    "nature bug = incorrect. perf = performance. process = workflow.",
    "duplicateOf only when another listed issue is the same request. Do not close anything.",
    "ciCause is one sentence naming the root cause, only for a pasted CI failure log.",
  ].join("\n");
}

function userPrompt(issue, neighbors) {
  const listed = neighbors
    .filter((item) => item.number !== issue.number)
    .map((item) => `#${item.number} ${item.title}`)
    .join("\n");
  return [
    `repo: ${issue.repo}`,
    `number: ${issue.number}`,
    `title: ${issue.title}`,
    `body:\n${issue.body || ""}`,
    `open issues in the same repo:\n${listed}`,
  ].join("\n\n");
}

function normalize(raw) {
  const kind = config.KIND_LABELS.some((label) => label.name === raw.kind) ? raw.kind : null;
  const domain = config.DOMAIN_VALUES.includes(raw.domain) ? raw.domain : null;
  const nature = config.NATURE_VALUES.includes(raw.nature) ? raw.nature : null;
  const duplicate = Number(raw.duplicateOf);
  const ciCause = typeof raw.ciCause === "string" ? raw.ciCause.replace(/\s+/g, " ").trim() : "";
  return {
    valid: raw.valid !== false && Boolean(kind && domain && nature),
    kind,
    domain,
    nature,
    duplicateOf: Number.isSafeInteger(duplicate) && duplicate > 0 ? duplicate : null,
    ciCause,
  };
}

function labelsFor(verdict) {
  if (!verdict.valid) return [config.DUTY_LABEL];
  return [
    verdict.kind,
    `\u57df:${verdict.domain}`,
    `\u6027\u8d28:${verdict.nature}`,
    config.DUTY_LABEL,
  ];
}

function commentsFor(issue, verdict) {
  const comments = [];
  if (verdict.duplicateOf && verdict.duplicateOf !== issue.number) {
    comments.push(`${DUPLICATE_MARKER}\n\u7591\u4f3c\u91cd\u590d #${verdict.duplicateOf}`);
  }
  if (verdict.ciCause) {
    comments.push(`${CI_MARKER}\n${verdict.ciCause}`);
  }
  return comments;
}

function planIssue(issue, verdict) {
  return {
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    skipped: false,
    verdict,
    labels: labelsFor(verdict),
    comments: commentsFor(issue, verdict),
  };
}

function selectIssues(issues, limit) {
  return [...issues]
    .filter((issue) => !(issue.labels || []).includes(config.DUTY_LABEL))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

async function triageIssues({ issues, neighbors, limit, completeFn }) {
  const selected = selectIssues(issues, limit);
  const actions = [];
  for (const issue of selected) {
    const raw = await completeFn([
      { role: "system", content: systemPrompt() },
      { role: "user", content: userPrompt(issue, neighbors.get(issue.repo) || []) },
    ]);
    actions.push(planIssue(issue, normalize(raw)));
  }
  const skipped = issues.length - selected.length;
  return { selected: selected.length, skipped, actions };
}

async function runTriage({ config: cfg, github, model, log }) {
  const open = [];
  const neighbors = new Map();
  for (const repo of cfg.repos) {
    const issues = await github.listOpenIssues(repo);
    neighbors.set(repo, issues);
    for (const issue of issues) open.push({ ...issue, repo });
  }
  const result = await triageIssues({
    issues: open,
    neighbors,
    limit: cfg.limit,
    completeFn: (messages) =>
      model
        ? model(messages)
        : complete({
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            apiKey: cfg.apiKey,
            messages,
          }),
  });
  for (const action of result.actions) {
    log(
      `${cfg.dryRun ? "dry-run" : "apply"} ${action.repo}#${action.number} ${action.labels.join(", ")}`,
    );
    for (const comment of action.comments) log(`  comment: ${comment.split("\n").at(-1)}`);
    if (cfg.dryRun) continue;
    await github.ensureLabels(action.repo, labelSpecs(action.labels));
    await github.addLabels(action.repo, action.number, action.labels);
    const existing = await github.listComments(action.repo, action.number);
    for (const comment of action.comments) {
      const marker = comment.startsWith(DUPLICATE_MARKER) ? DUPLICATE_MARKER : CI_MARKER;
      if (existing.some((body) => body.includes(marker))) continue;
      await github.comment(action.repo, action.number, comment);
    }
  }
  log(`triage done: looked ${result.selected}, skipped ${result.skipped}, limit ${cfg.limit}`);
  return result;
}

function labelSpecs(names) {
  const catalog = [...config.KIND_LABELS, ...config.QUERY_LABELS];
  return names.map((name) => {
    if (name === config.DUTY_LABEL) {
      return {
        name,
        color: config.DUTY_LABEL_COLOR,
        description: config.DUTY_LABEL_DESCRIPTION,
      };
    }
    const found = catalog.find((label) => label.name === name);
    if (!found) throw new Error(`no label spec for ${name}`);
    return found;
  });
}

module.exports = {
  MARKER,
  DUPLICATE_MARKER,
  CI_MARKER,
  systemPrompt,
  normalize,
  planIssue,
  selectIssues,
  triageIssues,
  runTriage,
  labelSpecs,
};
