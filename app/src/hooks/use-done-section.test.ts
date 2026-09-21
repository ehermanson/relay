import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDoneSectionDisclosure, useDoneTransitionPulse } from "./use-done-section";
import type { InboxEntry } from "@/lib/inbox";

function entries(...ids: string[]): InboxEntry[] {
  return ids.map((id) => ({ id, kind: "chat", instance: { id } }) as InboxEntry);
}

describe("useDoneSectionDisclosure", () => {
  it("stays collapsed when the open chat is marked done", () => {
    const { result, rerender } = renderHook(
      (props: { chatId: string; isActive: boolean; isDone: boolean }) =>
        useDoneSectionDisclosure(props),
      { initialProps: { chatId: "a", isActive: true, isDone: false } },
    );

    rerender({ chatId: "a", isActive: false, isDone: true });

    expect(result.current[0]).toBe(false);
  });

  it("stays collapsed after switching between two active chats", () => {
    // Regression: with the reset and the "saw it active" write in separate
    // effects, switching active chat → active chat reset the flag without
    // re-setting it, so the next mark-done expanded the section.
    const { result, rerender } = renderHook(
      (props: { chatId: string; isActive: boolean; isDone: boolean }) =>
        useDoneSectionDisclosure(props),
      { initialProps: { chatId: "a", isActive: true, isDone: false } },
    );

    rerender({ chatId: "b", isActive: true, isDone: false });
    rerender({ chatId: "b", isActive: false, isDone: true });

    expect(result.current[0]).toBe(false);
  });

  it("stays collapsed when the chat drops out of both lists mid-update", () => {
    const { result, rerender } = renderHook(
      (props: { chatId: string; isActive: boolean; isDone: boolean }) =>
        useDoneSectionDisclosure(props),
      { initialProps: { chatId: "a", isActive: true, isDone: false } },
    );

    rerender({ chatId: "a", isActive: false, isDone: false });
    rerender({ chatId: "a", isActive: false, isDone: true });

    expect(result.current[0]).toBe(false);
  });

  it("expands when arriving on a chat that is already done", () => {
    const { result, rerender } = renderHook(
      (props: { chatId: string; isActive: boolean; isDone: boolean }) =>
        useDoneSectionDisclosure(props),
      { initialProps: { chatId: "a", isActive: true, isDone: false } },
    );

    rerender({ chatId: "b", isActive: false, isDone: true });

    expect(result.current[0]).toBe(true);
  });

  it("expands when a chat opened before its lists loaded turns out to be done", () => {
    const { result, rerender } = renderHook(
      (props: { chatId: string; isActive: boolean; isDone: boolean }) =>
        useDoneSectionDisclosure(props),
      { initialProps: { chatId: "a", isActive: false, isDone: false } },
    );

    rerender({ chatId: "a", isActive: false, isDone: true });

    expect(result.current[0]).toBe(true);
  });

  it("expands when returning to a chat that was marked done earlier", () => {
    const { result, rerender } = renderHook(
      (props: { chatId: string; isActive: boolean; isDone: boolean }) =>
        useDoneSectionDisclosure(props),
      { initialProps: { chatId: "a", isActive: true, isDone: false } },
    );

    rerender({ chatId: "a", isActive: false, isDone: true });
    expect(result.current[0]).toBe(false);

    rerender({ chatId: "b", isActive: true, isDone: false });
    rerender({ chatId: "a", isActive: false, isDone: true });

    expect(result.current[0]).toBe(true);
  });
});

describe("useDoneTransitionPulse", () => {
  it("does not pulse on the first render, however the lists load", () => {
    const { result, rerender } = renderHook(
      (props: { active: InboxEntry[]; done: InboxEntry[] }) =>
        useDoneTransitionPulse(props.active, props.done),
      { initialProps: { active: entries(), done: entries() } },
    );

    rerender({ active: entries("a", "b"), done: entries("c", "d") });

    expect(result.current).toBe(0);
  });

  it("pulses once when a chat moves from active to done", () => {
    const { result, rerender } = renderHook(
      (props: { active: InboxEntry[]; done: InboxEntry[] }) =>
        useDoneTransitionPulse(props.active, props.done),
      { initialProps: { active: entries("a", "b"), done: entries() } },
    );

    rerender({ active: entries("b"), done: entries("a") });
    expect(result.current).toBe(1);

    // Steady state afterwards must not keep pulsing.
    rerender({ active: entries("b"), done: entries("a") });
    expect(result.current).toBe(1);
  });

  it("pulses once for a bulk sweep, not once per chat", () => {
    const { result, rerender } = renderHook(
      (props: { active: InboxEntry[]; done: InboxEntry[] }) =>
        useDoneTransitionPulse(props.active, props.done),
      { initialProps: { active: entries("a", "b", "c"), done: entries() } },
    );

    rerender({ active: entries(), done: entries("a", "b", "c") });

    expect(result.current).toBe(1);
  });

  it("does not pulse when a done chat is revived", () => {
    const { result, rerender } = renderHook(
      (props: { active: InboxEntry[]; done: InboxEntry[] }) =>
        useDoneTransitionPulse(props.active, props.done),
      { initialProps: { active: entries("b"), done: entries("a") } },
    );

    rerender({ active: entries("a", "b"), done: entries() });

    expect(result.current).toBe(0);
  });
});
