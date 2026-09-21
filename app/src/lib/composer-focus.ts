/**
 * Whether the composer may steal focus without a user gesture (opening a chat,
 * a plan or question arriving). On touch devices a programmatic focus raises
 * the keyboard and — in iOS standalone PWAs — pushes the whole page up, so the
 * composer only focuses there when the user taps into it.
 */
export function shouldAutoFocusComposer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return !window.matchMedia("(pointer: coarse)").matches;
}
