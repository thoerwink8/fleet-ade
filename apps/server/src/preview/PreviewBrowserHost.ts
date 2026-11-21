import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SETUP_SUBCOMMAND = "browser setup";

export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

export const sandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  env.T3CODE_SERVER_BROWSER_SANDBOX === "0";

export class PreviewBrowserSandboxError extends Schema.TaggedError<PreviewBrowserSandboxError>()(
  "PreviewBrowserSandboxError",
  { setupCommand: Schema.String },
) {
  override get message(): string {
    return `This host blocks the sandbox T3's browser runs in (AppArmor on Ubuntu 23.10+). Run \`${this.setupCommand}\` on the host once to allow it, then try again.`;
  }
}

export class PreviewBrowserLibrariesError extends Schema.TaggedError<PreviewBrowserLibrariesError>()(
  "PreviewBrowserLibrariesError",
  { setupCommand: Schema.String, libraries: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `This host is missing libraries T3's browser needs (${this.libraries.join(", ")}). Run \`${this.setupCommand}\` on the host to install them, then try again.`;
  }
}

/** Chrome will not start its sandbox as root (crbug.com/638180), which no host setup fixes. */
export class PreviewBrowserRootError extends Schema.TaggedError<PreviewBrowserRootError>()(
  "PreviewBrowserRootError",
  {},
) {
  override get message(): string {
    return "T3 server is running as root; Chrome's sandbox cannot start. Run T3 as a nonroot user. Otherwise set `T3CODE_SERVER_BROWSER_SANDBOX=0` in the T3 server's environment and restart the server; this disables Chrome's sandbox. Manual: `T3CODE_SERVER_BROWSER_SANDBOX=0 t3 serve`. Systemd: add `Environment=T3CODE_SERVER_BROWSER_SANDBOX=0` under `[Service]`, reload systemd, then restart the service. `t3 browser setup` cannot fix root sandboxing.";
  }
}

export type PreviewBrowserHostError =
  | PreviewBrowserSandboxError
  | PreviewBrowserLibrariesError
  | PreviewBrowserRootError;

export const diagnoseLaunchFailure = Effect.fn("PreviewBrowserHost.diagnoseLaunchFailure")(
  function* (input: {
    readonly executable: string;
    readonly output: string;
    readonly setupCommand: string;
  }) {
    const { setupCommand } = input;
    if (input.output.includes(NO_SANDBOX_SIGNATURE)) {
      // Playwright reports Chrome's refusal to sandbox as root as a sandbox failure too.
      return (yield* HostProcess.UserId) === 0
        ? new PreviewBrowserRootError()
        : new PreviewBrowserSandboxError({ setupCommand });
    }
    if ((yield* HostProcess.Platform) !== "linux") return undefined;
    const libraries = yield* missingLibraries(input.executable);
    return libraries.length === 0
      ? undefined
      : new PreviewBrowserLibrariesError({ setupCommand, libraries });
  },
);
