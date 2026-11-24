// Node version preflight. Loaded by .pnpmfile.cjs before any pnpm command and
// imported by scripts and vite.config.ts; keep it dependency-free CommonJS so
// it runs before `pnpm i` and inside pnpm's pnpmfile worker.

const NodeFS = require("node:fs");
const NodePath = require("node:path");

const repoRoot = NodePath.dirname(__dirname);

function parseVersion(raw) {
  const match = String(raw)
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

function compare(left, right) {
  if (left.major !== right.major) return left.major > right.major ? 1 : -1;
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;
  return 0;
}

// Same comparator semantics as packages/shared/src/semver.ts
// satisfiesSemverRange; the parity test keeps them in lockstep.
function satisfiesRange(rawVersion, range) {
  const version = parseVersion(rawVersion);
  if (!version) return false;
  return String(range)
    .split("||")
    .some((group) => {
      const comparators = group
        .trim()
        .replace(/(\^|>=|>|<=|<|=)\s+(?=v?\d)/g, "$1")
        .split(/\s+/)
        .filter(Boolean);
      if (comparators.length === 0) return false;
      return comparators.every((comparator) => {
        const match = comparator.trim().match(/^(\^|>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
        if (!match) return false;
        const targetMatch = match[2].match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
        if (!targetMatch) return false;
        const target = {
          major: Number(targetMatch[1]),
          minor: Number(targetMatch[2] ?? 0),
          patch: Number(targetMatch[3] ?? 0),
        };
        const compared = compare(version, target);
        const operator = match[1] || "=";
        switch (operator) {
          case "^":
            if (compared < 0) return false;
            if (target.major > 0 || targetMatch[2] === undefined) {
              return version.major === target.major;
            }
            if (target.minor > 0 || targetMatch[3] === undefined) {
              return version.major === 0 && version.minor === target.minor;
            }
            return version.major === 0 && version.minor === 0 && version.patch === target.patch;
          case ">=":
            return compared >= 0;
          case ">":
            return compared > 0;
          case "<=":
            return compared <= 0;
          case "<":
            return compared < 0;
          case "=":
            return compared === 0;
          default:
            return false;
        }
      });
    });
}
function readRequiredRange(rootDir) {
  try {
    const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(rootDir, "package.json"), "utf8"));
    const range = pkg?.engines?.node;
    return typeof range === "string" ? range : undefined;
  } catch {
    return undefined;
  }
}

function nodeVersionError(version, range) {
  return [
    `本仓需要 Node ${range}（见 package.json 的 engines.node），当前是 v${version}。`,
    "请切换到该版本后再运行本命令，例如 nvm use、fnm use、volta，或把对应安装目录放到 PATH 最前。",
  ].join("\n");
}

/** Returns the error text when `version` violates the repo pin, else undefined. */
function checkNodeVersion(version = process.versions.node, rootDir = repoRoot) {
  const range = readRequiredRange(rootDir);
  if (range === undefined) return undefined;
  if (satisfiesRange(version, range)) return undefined;
  return nodeVersionError(version, range);
}

/** Throws with the actionable message when the current Node violates the pin. */
function assertNodeVersion() {
  const message = checkNodeVersion();
  if (message !== undefined) {
    throw new Error(message);
  }
}

module.exports = {
  assertNodeVersion,
  checkNodeVersion,
  nodeVersionError,
  satisfiesRange,
};
