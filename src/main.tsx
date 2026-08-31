import React from "react";
import ReactDOM from "react-dom/client";
import { initBotId } from "botid/client/core";
import App from "./App";
import "./styles.css";

initBotId({
  protect: [{ path: "/api/imagineart/start", method: "POST" }],
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => void registration.unregister());
    }).catch(() => undefined);
  });
}
