import { describe, expect, it } from "vite-plus/test";

import { NETWORK_BLOCKING_HINT } from "./network.ts";
import * as Cause from "effect/Cause";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import {
  describeRequestFailure,
  isTransportConnectionErrorMessage,
  sanitizeThreadErrorMessage,
} from "./transport.ts";

const causeSchema = Schema.Cause(Schema.Unknown, Schema.Defect());
const decodeCause = Schema.decodeSync(causeSchema);
const encodeCause = Schema.encodeSync(causeSchema);

describe("isTransportConnectionErrorMessage", () => {
  it("returns true for React Native disconnected socket errors", () => {
    expect(
      isTransportConnectionErrorMessage(
        "The operation couldn't be completed. Socket is not connected",
      ),
    ).toBe(true);
  });

  it("recognizes relay connection errors that carry the network hint", () => {
    for (const sentence of [
      "Relay environment disconnected.",
      "Relay environment stopped responding.",
      "Relay environment could not establish a WebSocket connection.",
      "Relay environment 已断开连接。",
      "Relay environment 无法建立 WebSocket 连接。",
    ]) {
      expect(isTransportConnectionErrorMessage(`${sentence} ${NETWORK_BLOCKING_HINT}`)).toBe(true);
    }
    expect(
      isTransportConnectionErrorMessage(
        "Relay environment 已 20 秒无响应。它可能负载过高、处于睡眠状态或已断网。",
      ),
    ).toBe(true);
    expect(
      isTransportConnectionErrorMessage(
        "Your ChatGPT connection expired or was disconnected. Sign in again.",
      ),
    ).toBe(false);
  });
});

describe("describeRequestFailure", () => {
  const roundTrip = (error: unknown) => {
    const cause = Cause.fail(error);
    const decoded = decodeCause(encodeCause(cause));
    return describeRequestFailure(decoded);
  };

  it("turns an interrupted request into the shared sentence", () => {
    expect(describeRequestFailure(Cause.interrupt(1))).toEqual(
      new Error("连接已断开，内容已保留，恢复后再试。"),
    );
  });

  it("turns a closed socket into the shared sentence after a real round trip", () => {
    const failure = roundTrip(
      new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
    );
    expect(failure).toEqual(new Error("连接已断开，内容已保留，恢复后再试。"));
  });

  it("keeps a server rejection's own reason after a real round trip", () => {
    const rejection = new Error("此连接无权修改这些设置。");
    expect(roundTrip(rejection)).toEqual(rejection);
  });
});

describe("sanitizeThreadErrorMessage", () => {
  it("strips transport errors", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: oops")).toBeNull();
  });
});
