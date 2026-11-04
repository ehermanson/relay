import { createContext, useContext } from "react";
import type { UiViewResponse } from "@shared/ui-render";

export interface UiAnswerState {
  /** The recorded answer; inputs are disabled once there is one. */
  response?: UiViewResponse;
  /** The action being sent right now. */
  pending: string | null;
  error: string | null;
  answer: (actionId: string, values?: string[]) => void;
}

export const UiAnswerContext = createContext<UiAnswerState>({
  pending: null,
  error: null,
  answer: () => {},
});

export function useUiAnswer(): UiAnswerState {
  return useContext(UiAnswerContext);
}
