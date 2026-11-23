import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";

import { currentNetworkSnapshot } from "./snapshot.ts";
import { refreshSystemProxy } from "./systemProxy.ts";

type ProxyReadCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileMock = (...args: ReadonlyArray<unknown>) => unknown;

type ChildProcessModule = { readonly execFile: ExecFileMock; readonly [key: string]: unknown };
const nativeProbe = vi.hoisted(() => ({
  execFile: vi.fn<ExecFileMock>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<ChildProcessModule>();
  return { ...original, execFile: nativeProbe.execFile };
});

const windowsProxyOutput = (proxy: string) =>
  `ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    ${proxy}\n`;

describe("currentNetworkSnapshot", () => {
  effectIt.effect("publishes the refreshed system proxy and picks up a later change", () =>
    Effect.gen(function* () {
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      if (platformDescriptor === undefined) {
        throw new Error("process.platform is not configurable for the proxy test");
      }
      Object.defineProperty(process, "platform", { value: "win32" });
      const dateNow = vi.spyOn(Date, "now");
      const resolves: Array<(stdout: string) => void> = [];
      nativeProbe.execFile.mockImplementation((...args: ReadonlyArray<unknown>) => {
        const callback = args[args.length - 1] as ProxyReadCallback | undefined;
        if (callback !== undefined) {
          const pending = Promise.withResolvers<string>();
          resolves.push(pending.resolve);
          void pending.promise.then((stdout) => callback(null, stdout, ""));
        }
        return undefined;
      });

      try {
        dateNow.mockReturnValue(10_000);
        expect(currentNetworkSnapshot().system.proxyUrl).toBeNull();
        expect(nativeProbe.execFile).toHaveBeenCalledTimes(1);

        resolves[0]?.(windowsProxyOutput("http://proxy-a.test:8080"));
        // Joins the refresh that currentNetworkSnapshot started.
        yield* Effect.promise(() => refreshSystemProxy());
        expect(nativeProbe.execFile).toHaveBeenCalledTimes(1);
        expect(currentNetworkSnapshot().system.proxyUrl).toBe("http://proxy-a.test:8080");

        dateNow.mockReturnValue(12_001);
        expect(currentNetworkSnapshot().system.proxyUrl).toBe("http://proxy-a.test:8080");
        expect(nativeProbe.execFile).toHaveBeenCalledTimes(2);

        resolves[1]?.(windowsProxyOutput("http://proxy-b.test:8080"));
        yield* Effect.promise(() => refreshSystemProxy());
        expect(currentNetworkSnapshot().system.proxyUrl).toBe("http://proxy-b.test:8080");
      } finally {
        nativeProbe.execFile.mockReset();
        dateNow.mockRestore();
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
