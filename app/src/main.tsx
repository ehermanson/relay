import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { getDesktop } from "./lib/desktop";
import "./index.css";

const desktop = getDesktop();
if (desktop) {
  document.documentElement.classList.add("relay-desktop");
  document.documentElement.dataset.desktopPlatform = desktop.platform;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
