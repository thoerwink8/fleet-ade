import { useAtomValue } from "@effect/atom-react";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { useEffect, useRef, useState } from "react";
import { ensureLocalApi } from "../../localApi";
import { environmentPresentations } from "../../state/presentation";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  chatGptWelcomeProfiles,
  nextChatGptWelcomeProfile,
  type ChatGptWelcomeProfile,
} from "./ChatGptWelcome.logic";

const STORAGE_KEY = "t3:chatgpt-sharing-welcome:v1";

function readAcknowledgedProfiles(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

function announceProfile(profile: ChatGptWelcomeProfile): void {
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: "已连接你的 ChatGPT 套餐",
      description: `${profile.providerName}（${profile.environmentLabel}）的用量会计入你的 ChatGPT 套餐。`,
      actionProps: {
        children: "管理用量",
        onClick: () => void ensureLocalApi().shell.openExternal(CHATGPT_USAGE_URL),
      },
    }),
  );
}

/**
 * Each ChatGPT-sharing account is announced once, as a toast that times out on
 * its own. A dialog here would take focus away from whatever is being typed.
 */
export function ChatGptWelcomeCoordinator() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const [acknowledged, setAcknowledged] = useState(readAcknowledgedProfiles);
  const announcedRef = useRef(new Set<string>());
  const next = nextChatGptWelcomeProfile(
    chatGptWelcomeProfiles(
      [...presentations].map(([environmentId, presentation]) => ({
        environmentId,
        environmentLabel: presentation.entry.target.label,
        connected: presentation.connection.phase === "connected",
        providers: providersByEnvironment.get(environmentId) ?? [],
      })),
    ),
    acknowledged,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces a newly seen account outside React, then records it so the announcement never repeats
  useEffect(() => {
    // A ref, not only the stored list: StrictMode replays this effect before the state update lands.
    if (!next || announcedRef.current.has(next.key)) return;
    announcedRef.current.add(next.key);
    announceProfile(next);
    const updated = [...acknowledged, next.key];
    setAcknowledged(updated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {}
  }, [next, acknowledged]);

  return null;
}
