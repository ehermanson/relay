import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export interface RelaySourceChat {
  id: string;
  name: string;
}

export interface SpinOffRequest {
  anchorIndex?: number;
  selectedText?: string;
}

export interface InlineReplyRequest {
  id: string;
  anchorIndex?: number;
  selectedText: string;
  reply: string;
}

export interface InlineReplyFragment {
  id: string;
  selectedText: string;
  reply: string;
}

interface MessageRelayContextValue {
  sourceChat?: RelaySourceChat;
  onSendToSourceChat?: (messageText: string) => void;
  allowSpinOff?: boolean;
  /** Trigger a spin-off from this chat, optionally anchored to a message or excerpt */
  onSpinOff: (request?: SpinOffRequest) => void;
  /** Append a quoted inline reply into the current chat composer draft. */
  onInlineReply: (request: Omit<InlineReplyRequest, "id">) => void;
  /** Current instance ID for this chat */
  instanceId: string;
}

const MessageRelayContext = createContext<MessageRelayContextValue | null>(null);

export function MessageRelayProvider({
  value,
  children,
}: {
  value: MessageRelayContextValue;
  children: ReactNode;
}) {
  return <MessageRelayContext.Provider value={value}>{children}</MessageRelayContext.Provider>;
}

export function useMessageRelay(): MessageRelayContextValue | null {
  return useContext(MessageRelayContext);
}
