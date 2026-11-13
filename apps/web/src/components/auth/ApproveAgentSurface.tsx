import { useAuth, useClerk } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  type ConnectMcpApprovalCall,
  ConnectMcpApprovalUnavailableError,
} from "@t3tools/client-runtime/state/connectMcpApproval";
import { type AuthMcpApprovalDetails, EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../../env";
import { runConnectMcpApproval } from "../../state/connectMcpApproval";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import {
  type McpApprovalAnswer,
  type McpApprovalTransport,
  McpConsent,
  readAuthorizationRequest,
} from "./ConnectAgentSurface";

const isUnavailable = Schema.is(ConnectMcpApprovalUnavailableError);

function readEnvironmentId(): EnvironmentId | null {
  const value = new URL(window.location.href).searchParams.get("environment");
  return value ? EnvironmentId.make(value) : null;
}

/** Sends each call with the owner's T3 Connect session and remembers where the environment is. */
function connectTransport(
  environmentId: EnvironmentId,
  onEnvironment: (environment: { readonly url: string; readonly label: string }) => void,
): McpApprovalTransport {
  const send = async (
    call: ConnectMcpApprovalCall,
  ): Promise<McpApprovalAnswer<AuthMcpApprovalDetails>> => {
    const result = await runConnectMcpApproval(environmentId, call);
    if (Result.isFailure(result)) {
      return {
        kind: "error",
        message: isUnavailable(result.failure)
          ? result.failure.message
          : "无法访问此环境。请重试。",
      };
    }
    onEnvironment({
      url: result.success.environmentUrl,
      label: result.success.environmentLabel,
    });
    const { answer } = result.success;
    switch (answer.kind) {
      case "details":
        return { kind: "ok", value: answer.details };
      case "redirect":
        return { kind: "redirect", url: answer.url };
      case "refused":
        return { kind: "error", message: answer.message };
    }
  };
  return {
    load: (authorization) => send({ kind: "approval", payload: authorization }),
    decide: (authorization, decision) =>
      send({ kind: "decision", payload: { authorization, decision } }),
  };
}

/**
 * The consent screen for an agent sign-in on a T3 Connect environment: the owner signs in to
 * T3 Connect here and approves with that session, so no sign-in code is needed.
 */
export function ApproveAgentSurface() {
  const [environmentId] = useState(readEnvironmentId);
  const [authorization] = useState(readAuthorizationRequest);
  // Another site could frame this page and steer a click onto Approve.
  const [framed] = useState(() => window.top !== window.self);
  const [environment, setEnvironment] = useState<{
    readonly url: string;
    readonly label: string;
  } | null>(null);
  const [transport] = useState(() =>
    environmentId === null ? null : connectTransport(environmentId, setEnvironment),
  );
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const session = useAtomValue(managedRelaySessionAtom);
  const signInOpened = useRef(false);

  const openSignIn = () =>
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  const openSignInOnLoad = useEffectEvent(openSignIn);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens Clerk sign-in once Clerk has loaded and nobody is signed in
  useEffect(() => {
    if (!isLoaded || isSignedIn || signInOpened.current || framed) return;
    signInOpened.current = true;
    openSignInOnLoad();
  }, [framed, isLoaded, isSignedIn]);

  if (environmentId === null || transport === null) {
    return (
      <Message
        title="此登录链接不完整"
        description="请关闭此页面，然后从你的智能体重新发起登录。"
      />
    );
  }

  if (framed) {
    return (
      <Message
        title="请在单独的窗口中打开此页面"
        description="为了安全，不能在其他网站内批准智能体登录。"
      />
    );
  }

  if (!isLoaded || (isSignedIn && session === null)) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context="智能体登录"
          title="正在连接 T3 Connect"
          description="正在加载你的账号，请稍候。"
        />
        <Spinner className="mt-6" size="lg" tone="muted" />
      </StandalonePage>
    );
  }

  if (!isSignedIn) {
    return (
      <Message title="登录以批准" description="请使用此环境所关联的账号登录 T3 Connect。">
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            登录
          </Button>
        </div>
      </Message>
    );
  }

  const search = new URLSearchParams(window.location.search);
  search.delete("environment");
  return (
    <McpConsent
      authorization={authorization}
      transport={transport}
      requireLevelChoice
      environmentLabel={environment?.label}
      footer={
        <div className="mt-6 flex flex-wrap gap-2">
          {environment ? (
            <Button
              size="sm"
              variant="link"
              render={
                <a href={`${new URL("/connect-agent", environment.url).toString()}?${search}`} />
              }
            >
              改用登录码
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="link"
            onClick={() => void clerk.signOut({ redirectUrl: window.location.href })}
            type="button"
          >
            使用其他账号
          </Button>
        </div>
      }
    />
  );
}

function Message({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <StandalonePage>
      <StandalonePageHeader context="智能体登录" title={title} description={description} />
      {children}
    </StandalonePage>
  );
}
