import { expect, it } from "@effect/vitest";

import { missingLinkedEnvironment } from "./handlers.ts";

it("explains that an old link must be relinked when its environment identity is absent", () => {
  const failure = missingLinkedEnvironment();
  expect(failure.code).toBe("invalid_request");
  expect(failure.message).toContain("旧链接，请重新链接");
});
