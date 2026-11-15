/**
 * 决定 0115：能挡的只有三类。后两类没有具体位置、推测、风格、验收条以外的意见进建议。
 * 不读 diff、不起会话、不发网络。
 */

const BLOCKER_KINDS = ["没做到验收条", "弄坏了原有功能", "安全或丢数据"] as const;

/** 弄坏了原有功能、安全或丢数据要带的位置：反引号里的名字、带目录或扩展名的路径、「第 N 行」或 `:N`。 */
const EVIDENCE_PATTERN =
  /`[^`\n]+`|[\w@.-]+\/[\w@./-]+|[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|sql|md|ya?ml|sh|css|html)\b|第\s*\d+\s*行|:\d+\b/;

const CRITERION_NUMBER = /第\s*(\d+)\s*条/g;

export interface ColdVerifyFinding {
  readonly text: string;
}

/** 模型交来的一轮结论。一条都没写（问题、建议、交人都空，且没有 verdict）这一轮没验成。 */
export interface ColdVerifyModelOutput {
  readonly verdict: "pass" | "fail" | null;
  readonly problems: ReadonlyArray<ColdVerifyFinding>;
  readonly suggestions: ReadonlyArray<ColdVerifyFinding>;
  readonly handovers: ReadonlyArray<ColdVerifyFinding>;
}

export type ColdVerifyOutcome =
  | {
      readonly kind: "block";
      readonly problems: ReadonlyArray<string>;
      readonly suggestions: ReadonlyArray<string>;
      readonly handovers: ReadonlyArray<string>;
    }
  | {
      readonly kind: "pass";
      readonly suggestions: ReadonlyArray<string>;
      readonly handovers: ReadonlyArray<string>;
    }
  | { readonly kind: "unverified" }
  | {
      readonly kind: "handover";
      readonly suggestions: ReadonlyArray<string>;
      readonly handovers: ReadonlyArray<string>;
    };

export function isBlockingProblem(problem: string): boolean {
  if (problem.startsWith(BLOCKER_KINDS[0]!)) {
    return criterionNumbersIn(problem).length > 0;
  }
  if (problem.startsWith(BLOCKER_KINDS[1]!) || problem.startsWith(BLOCKER_KINDS[2]!)) {
    return EVIDENCE_PATTERN.test(problem);
  }
  return false;
}

function criterionNumbersIn(problem: string): ReadonlyArray<number> {
  return [...problem.matchAll(CRITERION_NUMBER)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isInteger(number) && number >= 1);
}

function texts(findings: ReadonlyArray<ColdVerifyFinding>): ReadonlyArray<string> {
  return findings.map((finding) => finding.text).filter((text) => text.trim() !== "");
}

/** 挡、按过、没验成、交人。交人不是不过。 */
export function judgeColdVerify(output: ColdVerifyModelOutput): ColdVerifyOutcome {
  const blocking = texts(output.problems).filter(isBlockingProblem);
  const nonBlocking = texts(output.problems).filter((problem) => !isBlockingProblem(problem));
  const suggestions = [...texts(output.suggestions), ...nonBlocking];
  const handovers = texts(output.handovers);
  const wroteNothing =
    output.verdict === null &&
    texts(output.problems).length === 0 &&
    suggestions.length === 0 &&
    handovers.length === 0;

  if (wroteNothing) return { kind: "unverified" };
  if (blocking.length > 0) {
    return { kind: "block", problems: blocking, suggestions, handovers };
  }
  if (handovers.length > 0) {
    return { kind: "handover", suggestions, handovers };
  }
  return { kind: "pass", suggestions, handovers };
}
