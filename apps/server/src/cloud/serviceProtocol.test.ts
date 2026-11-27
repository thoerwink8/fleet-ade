import { assert, it } from "@effect/vitest";

import { decodeServiceUnit, encodeServiceTask, serviceUnitBaseDirOf } from "./serviceProtocol.ts";

const encodeLegacyUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

it("writes a task as UTF-16LE with a BOM and decodes it back unchanged", () => {
  // schtasks decodes undeclared UTF-8 with the ANSI code page, mangling non-ASCII paths.
  const xml = `<Task><Arguments>--headless "C:\\t3\\node.exe" "--base-dir" "D:\\测试 目录\\t3-home"</Arguments></Task>`;
  const bytes = encodeServiceTask(xml);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(decodeServiceUnit(bytes), xml);
  assert.equal(serviceUnitBaseDirOf(decodeServiceUnit(bytes)), "D:\\测试 目录\\t3-home");
});

it("decodes a legacy UTF-8 task file written before UTF-16LE encoding", () => {
  const xml = `<Task><Arguments>--headless "C:\\t3\\node.exe" "--base-dir" "D:\\测试 目录\\t3-home"</Arguments></Task>`;
  const bytes = encodeLegacyUtf8(xml);
  assert.notDeepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(decodeServiceUnit(bytes), xml);
  assert.equal(serviceUnitBaseDirOf(decodeServiceUnit(bytes)), "D:\\测试 目录\\t3-home");
});
