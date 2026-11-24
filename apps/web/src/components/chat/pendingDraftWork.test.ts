import { describe, expect, it, vi } from "vite-plus/test";

import { pendingDraftWork } from "./pendingDraftWork";

describe("PendingDraftWork", () => {
  it("holds a draft until every transfer it started has finished", async () => {
    const pending = pendingDraftWork;
    const key = "concurrent-transfers";
    const defer = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    };
    const fast = defer();
    const slow = defer();
    const transfer = async (done: Promise<void>) => {
      pending.begin(key);
      try {
        await done;
      } finally {
        pending.end(key);
      }
    };
    const both = Promise.all([transfer(fast.promise), transfer(slow.promise)]);

    expect(pending.has(key)).toBe(true);
    fast.resolve();
    await fast.promise;
    expect(pending.has(key)).toBe(true);
    slow.resolve();
    await both;
    expect(pending.has(key)).toBe(false);
  });

  it("does not go negative when a transfer ends twice", () => {
    const pending = pendingDraftWork;
    pending.begin("double-end");
    pending.end("double-end");
    pending.end("double-end");
    pending.begin("double-end");
    expect(pending.has("double-end")).toBe(true);
    pending.end("double-end");
  });

  it("notifies subscribers, records failures, and resolves whenIdle without polling", async () => {
    const pending = pendingDraftWork;
    const key = "when-idle-signals";
    const listener = vi.fn();
    const unsubscribe = pending.subscribe(listener);

    expect(await pending.whenIdle(key)).toBe(true);

    pending.begin(key);
    expect(listener).toHaveBeenCalledTimes(1);

    let resolved: boolean | undefined;
    const waiting = pending.whenIdle(key).then((ok) => {
      resolved = ok;
      return ok;
    });
    await Promise.resolve();
    expect(resolved).toBeUndefined();

    pending.fail(key, "下载失败");
    expect(pending.lastFailure(key)).toMatchObject({ reason: "下载失败" });
    const firstSeq = pending.lastFailure(key)!.sequence;
    pending.fail(key, "再次失败");
    expect(pending.lastFailure(key)!.sequence).toBeGreaterThan(firstSeq);

    pending.end(key);
    expect(await waiting).toBe(true);
    unsubscribe();

    pending.begin(key);
    const controller = new AbortController();
    const abortedWait = pending.whenIdle(key, controller.signal);
    controller.abort();
    expect(await abortedWait).toBe(false);
    pending.end(key);
  });
});
