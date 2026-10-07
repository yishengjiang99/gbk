import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// Loaded after styles.css so the Winamp layout fixes win the cascade.
import "./winamp/layout.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
