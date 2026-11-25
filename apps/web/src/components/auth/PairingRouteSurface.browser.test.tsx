import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  submit: vi.fn<(credential: string) => Promise<void>>(),
}));

vi.mock(import("../../environments/primary"), async (original) => ({
  ...(await original()),
  submitServerAuthCredential: mocks.submit as never,
  peekPairingTokenFromUrl: () => null,
  stripPairingTokenFromUrl: () => {},
}));

import {
  PrimaryEnvironmentPairingCredentialRejectedError,
  PrimaryEnvironmentRequestError,
} from "../../environments/primary";
import { PairingRouteSurface } from "./PairingRouteSurface";

const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as never;

const input = () => page.getByPlaceholder("粘贴一次性配对码");

async function submitCredential(value: string) {
  await userEvent.fill(input(), value);
  await userEvent.click(page.getByRole("button", { name: "继续" }));
}

describe("PairingRouteSurface", () => {
  it("tells a bare /pair visit where to get a pairing code", async () => {
    await using _screen = await render(
      <PairingRouteSurface auth={auth} onAuthenticated={() => {}} />,
    );
    await expect.element(page.getByText(/设置 → 连接/)).toBeVisible();
    await expect.element(page.getByText(/t3 pair/)).toBeVisible();
  });

  it("explains a used code and clears the stale input", async () => {
    mocks.submit.mockRejectedValueOnce(
      new PrimaryEnvironmentPairingCredentialRejectedError({
        providedLength: 12,
        credentialFailureReason: "consumed",
        cause: new Error("rejected"),
      }),
    );
    await using _screen = await render(
      <PairingRouteSurface auth={auth} onAuthenticated={() => {}} />,
    );
    await submitCredential("OLDCODE12345");
    await expect.element(page.getByText(/这个配对码已经用过了/)).toBeVisible();
    await expect.element(input()).toHaveValue("");
  });

  it("keeps the input when the failure was connectivity, not the code", async () => {
    mocks.submit.mockRejectedValueOnce(
      PrimaryEnvironmentRequestError.fromCause({
        operation: "exchange-bootstrap-credential",
        cause: new TypeError("fetch failed"),
      }),
    );
    await using _screen = await render(
      <PairingRouteSurface auth={auth} onAuthenticated={() => {}} />,
    );
    await submitCredential("KEEPME123456");
    await expect.element(page.getByText(/连不上这台电脑/)).toBeVisible();
    await expect.element(input()).toHaveValue("KEEPME123456");
  });
});
