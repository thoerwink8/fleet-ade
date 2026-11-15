// GitHub reads and writes for duty. `gh` is spawned; nothing here stores a token.
const { execFileSync } = require("node:child_process");

function ghJson(args) {
  const stdout = execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function ghText(args, { input } = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
}

const ISSUES_QUERY = `
  query($owner:String!, $name:String!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      issues(first:50, after:$cursor, states:OPEN, orderBy:{field:CREATED_AT, direction:DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes { number title body createdAt state labels(first:50) { nodes { name } } }
      }
    }
  }`;

function listOpenIssues(repo) {
  const [owner, name] = repo.split("/");
  const issues = [];
  let cursor = null;
  do {
    const page = ghJson([
      "api",
      "graphql",
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      ...(cursor ? ["-f", `cursor=${cursor}`] : []),
      "-f",
      `query=${ISSUES_QUERY}`,
    ]);
    const connection = page.data.repository.issues;
    for (const node of connection.nodes) {
      if (node.state !== "OPEN") continue;
      issues.push({
        number: node.number,
        title: node.title,
        body: node.body || "",
        createdAt: node.createdAt,
        labels: node.labels.nodes.map((label) => label.name),
      });
    }
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return issues;
}

function ensureLabels(repo, specs) {
  for (const spec of specs) {
    ghText([
      "label",
      "create",
      spec.name,
      "--repo",
      repo,
      "--color",
      spec.color,
      "--description",
      spec.description,
      "--force",
    ]);
  }
}

function addLabels(repo, number, names) {
  ghText(["issue", "edit", String(number), "--repo", repo, "--add-label", names.join(",")]);
}

function listComments(repo, number) {
  const text = ghText([
    "api",
    "--paginate",
    `repos/${repo}/issues/${number}/comments`,
    "--jq",
    ".[].body",
  ]);
  return text.split("\n").filter((line) => line.length > 0);
}

function comment(repo, number, body) {
  ghText(["issue", "comment", String(number), "--repo", repo, "--body-file", "-"], {
    input: body,
  });
}

function listRetroRecords(repo, day) {
  const merged = ghText([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--search",
    `merged:${day}`,
    "--limit",
    "100",
    "--json",
    "number,title,body,mergedAt,url",
  ]);
  const red = ghText([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `updated:${day} status:failure`,
    "--limit",
    "100",
    "--json",
    "number,title,body,updatedAt,url",
  ]);
  const byNumber = new Map();
  const take = (rows, state, at) => {
    for (const row of JSON.parse(rows || "[]")) {
      const current = byNumber.get(row.number) || {
        number: row.number,
        title: row.title,
        body: row.body || "",
        updatedAt: row[at] || row.updatedAt,
        states: [],
      };
      if (!current.states.includes(state)) current.states.push(state);
      byNumber.set(row.number, current);
    }
  };
  take(merged, "merged", "mergedAt");
  take(red, "ci-red", "updatedAt");
  return [...byNumber.values()].map((record) => {
    const commits = commitSubjects(repo, record.number);
    const states = /\brevert\b/i.test(commits) ? [...record.states, "reverted"] : record.states;
    return {
      ...record,
      state: states.join("+"),
      commits,
      checks: checkRollup(repo, record.number),
    };
  });
}

function commitSubjects(repo, number) {
  try {
    return ghText([
      "api",
      `repos/${repo}/pulls/${number}/commits`,
      "--jq",
      '[.[:20][] | .commit.message | split("\n")[0]] | join("\n")',
    ]).trim();
  } catch {
    return "";
  }
}

function checkRollup(repo, number) {
  try {
    const text = ghText([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "statusCheckRollup",
      "--jq",
      "[.statusCheckRollup[]? | {name:.name, conclusion:(.conclusion // .state)}] | @json",
    ]);
    return JSON.parse(text.trim() || "[]");
  } catch {
    return [];
  }
}

function findPromotion(repo, marker) {
  const rows = JSON.parse(
    ghText([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      "\u5347\u89c4\u77e9 in:title",
      "--limit",
      "50",
      "--json",
      "number,title,body",
    ]) || "[]",
  );
  const found = rows.find((row) => (row.body || "").includes(marker));
  return found ? found.number : null;
}

function openIssue(repo, title, body) {
  const url = ghText(["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"], {
    input: body,
  }).trim();
  const number = Number(url.split("/").at(-1));
  if (!Number.isSafeInteger(number)) throw new Error(`could not read issue number from ${url}`);
  return number;
}

module.exports = {
  listOpenIssues,
  ensureLabels,
  addLabels,
  listComments,
  comment,
  listRetroRecords,
  findPromotion,
  openIssue,
};
