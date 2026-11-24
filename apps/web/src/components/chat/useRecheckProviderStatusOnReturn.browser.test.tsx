import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const refresh = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => refresh) as never,
}));

import { render } from "../../../test/render";
import { useRecheckProviderStatusOnReturn } from "./useRecheckProviderStatusOnReturn";

const environmentId = EnvironmentId.make("environment:test");
const instanceId = ProviderInstanceId.make("codex");

function Probe(props: { readonly enabled: boolean }) {
  useRecheckProviderStatusOnReturn({ environmentId, instanceId, enabled: props.enabled });
  return null;
}

it("checks once when shown as signed out, and not again for a burst of focus events", async () => {
  refresh.mockClear();
  await using _screen = await render(<Probe enabled />);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("does nothing while the agent is ready", async () => {
  refresh.mockClear();
  await using _screen = await render(<Probe enabled={false} />);
  window.dispatchEvent(new Event("focus"));
  expect(refresh).not.toHaveBeenCalled();
});
