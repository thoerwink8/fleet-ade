// Nightly retro. Reads the day's merged, reverted, and red-CI pull requests,
// asks SWE-2 for repeated rework, rough verification, and missed sibling fixes,
// then records them in LESSONS.md. Three different days open one review issue.
const { complete } = require("./duty-model.cjs");
const { parseLessons, renderLessons, observeLessons } = require("./duty-lessons.cjs");

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function systemPrompt() {
  return [
    "You review one day's merged, reverted, and red-CI pull requests.",
    'Reply with one JSON object: {"lessons": [{"id", "title", "summary", "kind"}]}.',
    "kind is one of rework, rough-verification, missed-sibling.",
    "rework: the same change was done again or rolled back.",
    "rough-verification: a check was skipped and the PR did not say Not run.",
    "missed-sibling: the same bug was left unfixed on another path.",
    "id is a stable lowercase slug. Use the same id when the lesson is the same as an existing one.",
    "summary is one or two sentences. Return an empty list when nothing qualifies.",
  ].join("\n");
}

function userPrompt(day, records, existing) {
  const known = existing.map((lesson) => `${lesson.id}: ${lesson.title}`).join("\n");
  const body = records
    .map((record) => {
      const checks = (record.checks || [])
        .map((check) => `${check.name}=${check.conclusion || check.status}`)
        .join(", ");
      return [
        `#${record.number} ${record.title} [${record.state}]`,
        record.body || "",
        checks ? `checks: ${checks}` : "",
        record.commits ? `commits:\n${record.commits}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  return `day: ${day}\n\nexisting lessons:\n${known || "(none)"}\n\npull requests:\n${body || "(none)"}`;
}

function normalizeLessons(raw) {
  const list = Array.isArray(raw?.lessons) ? raw.lessons : [];
  const seen = new Set();
  const lessons = [];
  for (const item of list) {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim() : "";
    const summary =
      typeof item.summary === "string" ? item.summary.replace(/\s+/g, " ").trim() : "";
    if (!ID.test(id) || !title || !summary || seen.has(id)) continue;
    seen.add(id);
    lessons.push({ id, title, summary, kind: item.kind || "" });
  }
  return lessons;
}

function promotionIssue(promotion) {
  return {
    title: `\u5347\u89c4\u77e9\uff1a${promotion.title}`,
    body: [
      "\u503c\u73ed\u590d\u76d8\u91cc\u540c\u4e00\u6761\u5df2\u5728 3 \u4e2a\u4e0d\u540c\u65e5\u5b50\u51fa\u73b0\u3002\u8bf7\u6307\u6325\u5b98\u5ba1\uff0c\u8981\u4e0d\u8981\u5347\u6210\u89c4\u77e9\u3002\u503c\u73ed\u4e0d\u81ea\u52a8\u6539\u89c4\u77e9\u3002",
      "",
      `\u6807\u9898\uff1a${promotion.title}`,
      `\u6458\u8981\uff1a${promotion.summary}`,
      `\u51fa\u73b0\u65e5\u671f\uff1a${promotion.dates.join(", ")}`,
      "",
      `<!-- duty:promote:${promotion.id} -->`,
    ].join("\n"),
    marker: `<!-- duty:promote:${promotion.id} -->`,
  };
}

function selectRecords(records, day) {
  return records.filter((record) => {
    const states = String(record.state || "").split("+");
    const onDay = String(record.updatedAt || "").slice(0, 10) === day;
    const counts =
      states.includes("merged") || states.includes("reverted") || states.includes("ci-red");
    return onDay && counts;
  });
}

async function runRetro({ config: cfg, github, model, fs, day, log }) {
  const records = [];
  for (const repo of cfg.repos) {
    const found = await github.listRetroRecords(repo, day);
    for (const record of found) records.push({ ...record, repo });
  }
  const selected = selectRecords(records, day).slice(0, cfg.limit);
  const current = parseLessons(await fs.readLessons(cfg.lessonsPath));
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(day, selected, current) },
  ];
  const raw = await (model
    ? model(messages)
    : complete({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: cfg.apiKey,
        messages,
      }));
  const incoming = normalizeLessons(raw);
  const { lessons, promotions } = observeLessons(current, incoming, day, cfg.promoteDays);
  const rendered = renderLessons(lessons);
  log(`${cfg.dryRun ? "dry-run" : "write"} ${cfg.lessonsPath}: ${lessons.length} lessons`);
  for (const lesson of incoming) log(`  lesson ${lesson.id}: ${lesson.title}`);
  if (!cfg.dryRun) await fs.writeLessons(cfg.lessonsPath, rendered);
  const opened = [];
  for (const promotion of promotions) {
    const issue = promotionIssue(promotion);
    log(`  promote ${promotion.id} on ${promotion.dates.join(", ")}`);
    if (cfg.dryRun) {
      opened.push({ ...issue, number: null });
      continue;
    }
    const exists = await github.findPromotion(cfg.repos[0], issue.marker);
    if (exists) {
      log(`  promotion already open: #${exists}`);
      continue;
    }
    const number = await github.openIssue(cfg.repos[0], issue.title, issue.body);
    opened.push({ ...issue, number });
    log(`  opened #${number}`);
  }
  log(
    `retro done: records ${selected.length}, lessons ${incoming.length}, promotions ${opened.length}`,
  );
  return { selected: selected.length, lessons: incoming, promotions: opened, rendered };
}

module.exports = {
  systemPrompt,
  normalizeLessons,
  promotionIssue,
  selectRecords,
  runRetro,
};
