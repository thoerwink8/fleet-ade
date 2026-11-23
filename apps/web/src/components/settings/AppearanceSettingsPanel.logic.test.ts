import { expect, it } from "vite-plus/test";

import { MATH_RENDERING_DESCRIPTION } from "./AppearanceSettingsPanel.logic";

it("shows math delimiters with one backslash, not the escaped JSX form", () => {
  expect(MATH_RENDERING_DESCRIPTION).toContain("\\[x^2\\]");
  expect(MATH_RENDERING_DESCRIPTION).not.toContain("\\\\[x^2\\\\]");
});
