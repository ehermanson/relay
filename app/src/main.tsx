import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { getDesktop } from "./lib/desktop";
import "./index.css";

const desktop = getDesktop();
if (desktop) {
  document.documentElement.classList.add("relay-desktop");
  document.documentElement.dataset.desktopPlatform = desktop.platform;
  // Native profiling can request aggregate counts; no transcript or mutation
  // API is exposed, and the instrumentation loads only when requested.
  window.addEventListener("relay:memory-diagnostics", () => {
    void Promise.all([
      import("./hooks/use-instance-messages"),
      import("./lib/pretext"),
      import("./routes/__root"),
      import("./app"),
    ]).then(([history, text, queries, router]) => {
      window.dispatchEvent(
        new CustomEvent("relay:memory-diagnostics-result", {
          detail: {
            history: history.getInstanceMessagesCacheStats(),
            textLayout: text.getTextLayoutCacheStats(),
            queries: queries.getQueryMemoryStats(),
            router: router.getRouterMemoryStats(),
          },
        }),
      );
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
