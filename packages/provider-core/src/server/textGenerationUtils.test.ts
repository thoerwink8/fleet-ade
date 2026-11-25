import { describe, expect, it } from "vite-plus/test";

import {
  classifyTextGenerationCliFailure,
  limitSection,
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

describe("limitSection", () => {
  it("cuts a long section without splitting an emoji", () => {
    expect(limitSection(`${"a".repeat(9)}🚀 more`, 10)).toBe(`${"a".repeat(9)}\n\n[truncated]`);
  });
});

describe("sanitizeCommitSubject", () => {
  // regression: #19181 truncation split grapheme clusters at the subject limit
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});

describe("sanitizeThreadTitle", () => {
  it.each([
    { name: "a split surrogate pair", prefixLength: 116, character: "🚀", retained: "" },
    { name: "a complete surrogate pair", prefixLength: 115, character: "🚀", retained: "🚀" },
    { name: "a BMP character", prefixLength: 116, character: "界", retained: "界" },
  ])("truncates without splitting $name", ({ prefixLength, character, retained }) => {
    const prefix = "a".repeat(prefixLength);
    const title = `${prefix}${character} more`;

    expect(sanitizeThreadTitle(title)).toBe(`${prefix}${retained}...`);
  });
});

describe("classifyTextGenerationCliFailure", () => {
  it.each([
    { text: "Command not found: codex", reason: "not_installed" },
    { text: "Not logged in. Please run login.", reason: "unauthenticated" },
    { text: "HTTP 401 unauthorized: invalid api key", reason: "unauthenticated" },
    { text: "Rate limit reached (429 Too Many Requests)", reason: "rate_limited" },
    { text: "Request timed out after 180s (ETIMEDOUT)", reason: "timeout" },
    { text: "connect ECONNREFUSED 127.0.0.1:443", reason: "network" },
    { text: "503 Service Unavailable", reason: "unavailable" },
    { text: "Unexpected JSON schema validation error", reason: undefined },
  ])("classifies $text -> $reason", ({ text, reason }) => {
    expect(classifyTextGenerationCliFailure(text)).toBe(reason);
  });
});

describe("normalizeCliError", () => {
  it("marks missing CLI executables with not_installed while keeping detail unchanged", () => {
    const error = normalizeCliError(
      "claude",
      "generateThreadTitle",
      new Error("spawn claude ENOENT"),
      "Fallback failure",
    );
    expect(error._tag).toBe("TextGenerationError");
    expect(error.reason).toBe("not_installed");
    expect(error.detail).toBe("Claude CLI (`claude`) is required but not available on PATH.");
  });
});
