import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** Joined at runtime so this file does not contain a banned hostname. */
export function dotted(...parts: readonly string[]): string {
  return parts.join(".");
}

const HOST_SUFFIXES = [dotted("t3", "codes"), dotted("t3coderelay", "com")];

export function bannedHostPattern(): RegExp {
  const suffixes = HOST_SUFFIXES.map((value) => value.replace(/[.]/g, "\\."));
  return new RegExp(
    `(?:^|[^a-z0-9.-])((?:[a-z0-9-]+\\.)*(?:${suffixes.join("|")}))(?![a-z0-9.-])`,
    "i",
  );
}

export function isBannedHost(host: string): boolean {
  return bannedHostPattern().test(host);
}

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".t3",
  "third-party-licenses",
  "docs",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".json",
  ".yml",
  ".yaml",
  ".xml",
  ".sh",
  ".ps1",
  ".astro",
  ".css",
  ".html",
  ".svg",
  ".toml",
  ".vue",
  ".kt",
  ".swift",
  ".txt",
  ".example",
]);

export const scanTheirHosts = Effect.fn("theirServices.scanTheirHosts")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hits: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of names) {
      if (SKIP_DIRECTORIES.has(name)) continue;
      const full = path.join(dir, name);
      const stat = yield* fs.stat(full).pipe(Effect.option);
      if (Option.isNone(stat)) continue;
      if (stat.value.type === "Directory") {
        pending.push(full);
        continue;
      }
      const base = path.basename(full);
      if (base.startsWith("LICENSE")) continue;
      const extension = path.extname(full);
      if (extension === ".md") continue;
      if (!TEXT_EXTENSIONS.has(extension) && base !== ".env.example") continue;
      const text = yield* fs.readFileString(full).pipe(Effect.orElseSucceed(() => ""));
      const found = text.match(new RegExp(bannedHostPattern().source, "gi"));
      if (found) hits.push(`${path.relative(root, full)} ${found.length}`);
    }
  }
  return hits;
});
