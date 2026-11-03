/**
 * Measured heights of `html_render` pages, by render id. The virtualized chat
 * list unmounts off-screen frames; remounting at the agent's guessed height
 * and then growing would make the list jump.
 */
const measured = new Map<string, number>();
const MAX_ENTRIES = 500;

export function getHtmlRenderHeight(renderId: string): number | undefined {
  return measured.get(renderId);
}

export function setHtmlRenderHeight(renderId: string, height: number): void {
  measured.delete(renderId);
  measured.set(renderId, height);
  if (measured.size > MAX_ENTRIES) measured.delete(measured.keys().next().value!);
}
