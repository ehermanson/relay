/**
 * Disclosure + acknowledgement state for the inbox sidebar's "Done" section.
 *
 * Extracted from the sidebar so the rules can be tested directly: they are
 * about *transitions* (did this chat move into Done while it was open? did any
 * chat move into Done at all?), which is exactly the kind of logic that reads
 * as obviously correct and then misfires on the third render.
 */

import { useEffect, useRef, useState } from "react";
import type { InboxEntry } from "@/lib/inbox";

/**
 * Owns whether the Done section is expanded.
 *
 * Expands when you *arrive* on a chat that is already done, so the open chat is
 * never hidden — but never because the open chat just became done: a collapsed
 * list jumping open under the cursor is worse than the chat scrolling out of
 * view. `sawActive` separates the two, and (unlike "did done-ness change?")
 * can't misfire while the lists are still loading and the chat is in neither.
 *
 * All three steps share ONE effect on purpose. Split across effects with
 * narrower deps, the per-chat reset ran on chat-change while the "saw it
 * active" write was skipped — its `isActive` dep hadn't changed (active chat →
 * active chat) — so the next mark-done read a stale `false` and expanded. Which
 * chat you came from decided whether it misfired, hence the intermittency.
 */
export function useDoneSectionDisclosure({
  chatId,
  isActive,
  isDone,
}: {
  chatId: string | undefined;
  isActive: boolean;
  isDone: boolean;
}): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const sawActiveRef = useRef(false);
  const openChatRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (openChatRef.current !== chatId) {
      openChatRef.current = chatId;
      sawActiveRef.current = false;
    }
    if (isActive) sawActiveRef.current = true;
    else if (isDone && !sawActiveRef.current) setOpen(true);
  }, [chatId, isActive, isDone]);

  return [open, setOpen];
}

/**
 * Counter that increments each time one or more chats move from the active list
 * into Done — the signal behind the "Done N" header pulse, which acknowledges
 * the change without expanding anything.
 *
 * Keyed off ids that were active on the previous render rather than
 * `done.length`, which also jumps when the lists first load or when a project
 * filter changes. A sweep of many chats bumps it once, not once per chat.
 */
export function useDoneTransitionPulse(active: InboxEntry[], done: InboxEntry[]): number {
  const [pulse, setPulse] = useState(0);
  const prevActiveIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    const prevActive = prevActiveIdsRef.current;
    prevActiveIdsRef.current = new Set(active.map((entry) => entry.id));
    if (!prevActive) return;
    if (done.some((entry) => prevActive.has(entry.id))) setPulse((n) => n + 1);
  }, [active, done]);

  return pulse;
}
