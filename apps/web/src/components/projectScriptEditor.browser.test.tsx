import "~/index.css";
import { act, render, type Screen } from "../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  ProjectScriptEditorDialog,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";

const onSubmit = vi.fn<Parameters<typeof ProjectScriptEditorDialog>[0]["onSubmit"]>();
const onClose = vi.fn();
const onDelete = vi.fn();

function request(name: string, error?: string): ProjectScriptEditorRequest {
  return {
    scriptId: name,
    initial: { ...EMPTY_PROJECT_SCRIPT_INPUT, name, command: `run-${name}` },
    ...(error === undefined ? {} : { error }),
  };
}

const open = (screen: Screen, nextRequest: ProjectScriptEditorRequest) =>
  screen.rerender(
    <StrictMode>
      <ProjectScriptEditorDialog
        environmentId={EnvironmentId.make("test")}
        request={nextRequest}
        scripts={[]}
        onSubmit={onSubmit}
        onClose={onClose}
        onDelete={onDelete}
      />
    </StrictMode>,
  );

const submit = () => document.querySelector("form")!.requestSubmit();
const saveButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;

function deferredSave() {
  let resolve!: (result: ProjectScriptActionResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ProjectScriptActionResult>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  return { promise, resolve, reject };
}

function setup() {
  onSubmit.mockReset();
  onClose.mockReset();
  onDelete.mockReset();
}

function controlHeight(variable: string): string {
  const probe = document.createElement("div");
  probe.style.height = `var(${variable})`;
  document.body.append(probe);
  try {
    return getComputedStyle(probe).height;
  } finally {
    probe.remove();
  }
}

describe("project action editor save lifecycle", () => {
  it("keeps the icon trigger on the 32px step beside the name field", async () => {
    setup();
    const previous = { width: window.innerWidth, height: window.innerHeight };
    await using screen = await render(null);
    try {
      for (const [width, height] of [
        [1280, 800],
        [390, 844],
      ] as const) {
        await page.viewport(width, height);
        await open(screen, request("build"));
        const trigger = screen.getByRole("button", { name: "选择图标" }).element();
        const nameField = document.querySelector<HTMLInputElement>("#script-name")!;
        const expected = controlHeight("--fa-ctrl");
        expect(getComputedStyle(trigger).width, `${width}px width`).toBe(expected);
        expect(getComputedStyle(trigger).height, `${width}px height`).toBe(expected);
        const fieldHeight = nameField.getBoundingClientRect().height;
        const triggerHeight = trigger.getBoundingClientRect().height;
        if (width >= 640) expect(fieldHeight, `${width}px field`).toBe(triggerHeight);
        else expect(fieldHeight, `${width}px field`).toBeGreaterThan(triggerHeight);
      }
    } finally {
      await page.viewport(previous.width, previous.height);
    }
  });

  it("does not close a replacement request or release its in-flight save", async () => {
    setup();
    await using screen = await render(null);
    const first = deferredSave();
    const second = deferredSave();
    onSubmit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await open(screen, request("build"));
    await act(async () => submit());

    await open(screen, request("test"));
    expect(saveButton().disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#script-name")!.value).toBe("test");
    await act(async () => submit());

    await act(async () => first.resolve(AsyncResult.success(undefined)));
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);

    await act(async () => second.resolve(AsyncResult.success(undefined)));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls.map(([scriptId]) => scriptId)).toEqual(["build", "test"]);
  });
});
