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
