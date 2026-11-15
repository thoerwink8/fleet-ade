const assert = require("node:assert/strict");
const test = require("node:test");

const { loadConfig, DUTY_LABEL } = require("./duty-config.cjs");
const { extractJson } = require("./duty-model.cjs");
const { parseLessons, renderLessons, observeLessons } = require("./duty-lessons.cjs");
const {
  normalize,
  planIssue,
  selectIssues,
  triageIssues,
  runTriage,
} = require("./duty-triage.cjs");
const { normalizeLessons, selectRecords, runRetro } = require("./duty-retro.cjs");

const issue = (number, extra = {}) => ({
  repo: "thoerwink8/fleet-ade",
  number,
  title: `issue ${number}`,
  body: "body",
  createdAt: `2026-11-${String(number).padStart(2, "0")}T00:00:00Z`,
  labels: [],
  ...extra,
});

test("config reads the gateway from the environment and refuses a live run without a key", () => {
  const dry = loadConfig({}, ["triage", "--dry-run"]);
  assert.equal(dry.baseUrl, "http://127.0.0.1:3425/v1");
  assert.equal(dry.model, "group/swe-pool");
  assert.equal(dry.limit, 10);
  assert.equal(dry.dryRun, true);
  const france = loadConfig(
    { MAGPIE_BASE_URL: "http://192.0.2.2:3425/v1/", MAGPIE_API_KEY: "secret", DUTY_LIMIT: "3" },
    ["retro"],
  );
  assert.equal(france.baseUrl, "http://192.0.2.2:3425/v1");
  assert.equal(france.limit, 3);
  assert.equal(france.dryRun, false);
  assert.throws(() => loadConfig({}, ["triage"]), /MAGPIE_API_KEY/);
  assert.throws(() => loadConfig({}, ["triage", "--nope"]), /unknown argument/);
});

test("model replies may be fenced and still parse as one object", () => {
  assert.deepEqual(extractJson('```json\n{"valid":true}\n```'), { valid: true });
  assert.throws(() => extractJson("no object"), /no JSON object/);
});

test("triage keeps the newest unmarked issues inside the limit and skips marked ones", () => {
  const issues = [issue(1), issue(2, { labels: [DUTY_LABEL] }), issue(3), issue(4)];
  assert.deepEqual(
    selectIssues(issues, 2).map((item) => item.number),
    [4, 3],
  );
});

test("triage plans labels and one duplicate comment, and drops a verdict outside the vocabulary", () => {
  const planned = planIssue(
    issue(8),
    normalize({
      valid: true,
      kind: "\u7f3a\u9677",
      domain: "engine",
      nature: "bug",
      duplicateOf: 3,
      ciCause: "  storageCleanup \n failed on locale  ",
    }),
  );
  assert.deepEqual(planned.labels, [
    "\u7f3a\u9677",
    "\u57df:engine",
    "\u6027\u8d28:bug",
    DUTY_LABEL,
  ]);
  assert.equal(planned.comments.length, 2);
  assert.match(planned.comments[0], /\u7591\u4f3c\u91cd\u590d #3/);
  assert.match(planned.comments[1], /storageCleanup failed on locale/);
  const invalid = planIssue(issue(9), normalize({ valid: true, kind: "other", domain: "web" }));
  assert.equal(invalid.verdict.valid, false);
  assert.deepEqual(invalid.labels, [DUTY_LABEL]);
  assert.deepEqual(invalid.comments, []);
});

test("triage uses the model stand-in and does not write during a dry run", async () => {
  const calls = [];
  const github = {
    listOpenIssues: async () => [issue(1), issue(2, { labels: [DUTY_LABEL] })],
    ensureLabels: async () => calls.push("labels"),
    addLabels: async () => calls.push("add"),
    listComments: async () => [],
    comment: async () => calls.push("comment"),
  };
  const lines = [];
  const result = await runTriage({
    config: {
      repos: ["thoerwink8/fleet-ade"],
      limit: 10,
      dryRun: true,
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "group/swe-pool",
      apiKey: "",
    },
    github,
    model: async () => ({
      valid: true,
      kind: "\u9700\u6c42",
      domain: "mirasim",
      nature: "process",
    }),
    log: (line) => lines.push(line),
  });
  assert.equal(result.selected, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(calls, []);
  assert.match(lines.join("\n"), /dry-run thoerwink8\/fleet-ade#1/);
});

test("triage comments once: a marker already on the issue is not posted again", async () => {
  const posted = [];
  const result = await triageIssues({
    issues: [issue(5)],
    neighbors: new Map([["thoerwink8/fleet-ade", [issue(5), issue(4)]]]),
    limit: 10,
    completeFn: async () => ({
      valid: true,
      kind: "\u7f3a\u9677",
      domain: "api",
      nature: "perf",
      duplicateOf: 4,
      ciCause: "timeout in browser test",
    }),
  });
  assert.equal(result.actions[0].comments.length, 2);
  const github = {
    ensureLabels: async () => {},
    addLabels: async () => {},
    listComments: async () => result.actions[0].comments,
    comment: async (_repo, _number, body) => posted.push(body),
  };
  await runTriage({
    config: {
      repos: ["thoerwink8/fleet-ade"],
      limit: 10,
      dryRun: false,
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "group/swe-pool",
      apiKey: "secret",
    },
    github: {
      ...github,
      listOpenIssues: async () => [issue(5)],
    },
    model: async () => ({
      valid: true,
      kind: "\u7f3a\u9677",
      domain: "api",
      nature: "perf",
      duplicateOf: 4,
      ciCause: "timeout in browser test",
    }),
    log: () => {},
  });
  assert.deepEqual(posted, []);
});

test("lessons count distinct days and promote on the third day only", () => {
  const first = observeLessons(
    [],
    [{ id: "rough-check", title: "\u9a8c\u8bc1\u592a\u7cd9", summary: "\u6ca1\u5199 Not run" }],
    "2026-11-14",
    3,
  );
  const second = observeLessons(
    first.lessons,
    [{ id: "rough-check", title: "\u9a8c\u8bc1\u592a\u7cd9", summary: "\u6ca1\u5199 Not run" }],
    "2026-11-14",
    3,
  );
  assert.equal(second.lessons[0].seen, 1);
  assert.deepEqual(second.promotions, []);
  const third = observeLessons(
    second.lessons,
    [{ id: "rough-check", title: "\u9a8c\u8bc1\u592a\u7cd9", summary: "\u6ca1\u5199 Not run" }],
    "2026-11-15",
    3,
  );
  const fourth = observeLessons(
    third.lessons,
    [{ id: "rough-check", title: "\u9a8c\u8bc1\u592a\u7cd9", summary: "\u6ca1\u5199 Not run" }],
    "2026-11-16",
    3,
  );
  assert.equal(fourth.promotions.length, 1);
  assert.deepEqual(fourth.promotions[0].dates, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  const again = observeLessons(
    fourth.lessons,
    [{ id: "rough-check", title: "\u9a8c\u8bc1\u592a\u7cd9", summary: "\u6ca1\u5199 Not run" }],
    "2026-11-17",
    3,
  );
  assert.deepEqual(again.promotions, []);
  const parsed = parseLessons(renderLessons(again.lessons));
  assert.equal(parsed[0].seen, 4);
  assert.deepEqual(parsed[0].dates, again.lessons[0].dates);
});

test("retro keeps merged, reverted, and red CI records and ignores a plain close", () => {
  const records = [
    { number: 1, state: "merged", updatedAt: "2026-11-16T01:00:00Z" },
    { number: 2, state: "closed", updatedAt: "2026-11-16T01:00:00Z" },
    { number: 3, state: "merged+reverted", updatedAt: "2026-11-16T02:00:00Z" },
    { number: 4, state: "ci-red", updatedAt: "2026-11-15T02:00:00Z" },
  ];
  assert.deepEqual(
    selectRecords(records, "2026-11-16").map((record) => record.number),
    [1, 3],
  );
});

test("retro drops lessons the model did not identify and does not write on a dry run", async () => {
  const written = [];
  const opened = [];
  const lines = [];
  const existing = renderLessons([
    {
      id: "same-fix",
      title: "\u540c\u7c7b\u6f0f\u4fee",
      summary: "\u53ea\u4fee\u4e86\u4e00\u6761\u8def\u5f84",
      seen: 2,
      dates: ["2026-11-14", "2026-11-15"],
    },
  ]);
  const result = await runRetro({
    config: {
      repos: ["thoerwink8/fleet-ade"],
      limit: 10,
      dryRun: true,
      lessonsPath: "LESSONS.md",
      promoteDays: 3,
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "group/swe-pool",
      apiKey: "",
    },
    github: {
      listRetroRecords: async () => [
        {
          number: 9,
          title: "fix",
          body: "Not run: mobile",
          state: "merged",
          updatedAt: "2026-11-16T03:00:00Z",
          commits: "fix",
          checks: [],
        },
      ],
      findPromotion: async () => opened.push("find"),
      openIssue: async () => opened.push("open"),
    },
    model: async () => ({
      lessons: [
        {
          id: "same-fix",
          title: "\u540c\u7c7b\u6f0f\u4fee",
          summary: "\u53ea\u4fee\u4e86\u4e00\u6761\u8def\u5f84",
          kind: "missed-sibling",
        },
        { id: "Bad Id", title: "nope", summary: "nope" },
        { id: "", title: "", summary: "" },
      ],
    }),
    fs: {
      readLessons: async () => existing,
      writeLessons: async (_path, text) => written.push(text),
    },
    day: "2026-11-16",
    log: (line) => lines.push(line),
  });
  assert.deepEqual(
    normalizeLessons({
      lessons: [
        { id: "ok", title: "t", summary: "s" },
        { id: "OK", title: "t", summary: "s" },
      ],
    }).map((item) => item.id),
    ["ok"],
  );
  assert.equal(result.promotions.length, 1);
  assert.equal(result.promotions[0].number, null);
  assert.match(result.rendered, /Seen 3\u00d7 \u00b7 2026-11-14, 2026-11-15, 2026-11-16/);
  assert.deepEqual(written, []);
  assert.deepEqual(opened, []);
  assert.match(lines.join("\n"), /dry-run LESSONS.md/);
});
