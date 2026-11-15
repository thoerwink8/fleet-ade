import { describe, expect, it } from "@effect/vitest";

import {
  isBlockingProblem,
  judgeColdVerify,
  type ColdVerifyFinding,
  type ColdVerifyModelOutput,
} from "./coldVerifyVerdict.ts";

const finding = (text: string): ColdVerifyFinding => ({ text });

const output = (patch: Partial<ColdVerifyModelOutput> = {}): ColdVerifyModelOutput => ({
  verdict: null,
  problems: [],
  suggestions: [],
  handovers: [],
  ...patch,
});

describe("coldVerifyVerdict", () => {
  it("没做到验收条、带位置的弄坏原有功能和安全或丢数据挡合并", () => {
    expect(isBlockingProblem("没做到验收条：第 2 条要求的测试没出现")).toBe(true);
    expect(
      isBlockingProblem("弄坏了原有功能：`apps/server/src/git/GitManager.ts` 的还原不再写回"),
    ).toBe(true);
    expect(isBlockingProblem("安全或丢数据：密钥写进了 apps/server/src/config.ts 第 40 行")).toBe(
      true,
    );

    const judged = judgeColdVerify(
      output({
        verdict: "fail",
        problems: [
          finding("没做到验收条：第 2 条要求的测试没出现"),
          finding("弄坏了原有功能：`GitManager.ts` 的还原不再写回"),
          finding("安全或丢数据：密钥写进了 config.ts 第 40 行"),
        ],
        suggestions: [finding("命名可以再短一点")],
      }),
    );

    expect(judged.kind).toBe("block");
    if (judged.kind !== "block") return;
    expect(judged.problems).toEqual([
      "没做到验收条：第 2 条要求的测试没出现",
      "弄坏了原有功能：`GitManager.ts` 的还原不再写回",
      "安全或丢数据：密钥写进了 config.ts 第 40 行",
    ]);
    expect(judged.suggestions).toEqual(["命名可以再短一点"]);
  });

  it("没有具体位置的后两类、推测、风格和验收条以外的意见不挡", () => {
    expect(isBlockingProblem("没做到验收条：看起来少了点什么")).toBe(false);
    expect(isBlockingProblem("弄坏了原有功能：可能会让还原变慢")).toBe(false);
    expect(isBlockingProblem("安全或丢数据：这里大概不安全")).toBe(false);

    const judged = judgeColdVerify(
      output({
        verdict: "fail",
        problems: [
          finding("没做到验收条：看起来少了点什么"),
          finding("弄坏了原有功能：可能会让还原变慢"),
          finding("安全或丢数据：这里大概不安全"),
          finding("并发边界没说清"),
        ],
        suggestions: [finding("风格：这个名字太长")],
      }),
    );

    expect(judged).toEqual({
      kind: "pass",
      suggestions: [
        "风格：这个名字太长",
        "没做到验收条：看起来少了点什么",
        "弄坏了原有功能：可能会让还原变慢",
        "安全或丢数据：这里大概不安全",
        "并发边界没说清",
      ],
      handovers: [],
    });
  });

  it("模型写了失败但没有任何能挡的问题，按过", () => {
    expect(judgeColdVerify(output({ verdict: "fail" }))).toEqual({
      kind: "pass",
      suggestions: [],
      handovers: [],
    });
    expect(
      judgeColdVerify(output({ verdict: "fail", suggestions: [finding("可以再补一条注释")] })),
    ).toMatchObject({ kind: "pass", suggestions: ["可以再补一条注释"] });
  });

  it("一条结论都没写，这一轮没验成", () => {
    expect(judgeColdVerify(output())).toEqual({ kind: "unverified" });
    expect(
      judgeColdVerify(
        output({
          problems: [finding("   ")],
          suggestions: [finding("")],
          handovers: [finding("  ")],
        }),
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("要 diff 外面的证据才判得了的，交人，不判不过", () => {
    const judged = judgeColdVerify(
      output({
        verdict: "fail",
        handovers: [finding("第 3 条要看线上用量，diff 里没有")],
        suggestions: [finding("命名可以再短一点")],
      }),
    );

    expect(judged).toEqual({
      kind: "handover",
      suggestions: ["命名可以再短一点"],
      handovers: ["第 3 条要看线上用量，diff 里没有"],
    });
  });
});
