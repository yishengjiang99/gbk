import "./telemetry/install.ts";
import { funnelBeacon } from "./telemetry/funnel.ts";
// Aggregate landing-page count (no identifiers); the Studio and other routes are not counted.
if (location.pathname === "/") funnelBeacon("page_view_landing", "web");
import React from "react";
import ReactDOM from "react-dom/client";
import Root from "./Root";
import "./components/workstation/workstation.css";
import "./styles.css";
// Loaded after styles.css so the Winamp layout fixes win the cascade.
import "./winamp/layout.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
