import React from "react";
import ReactDOM from "react-dom/client";
import { SheetCam } from "./sheet-cam.tsx";

// Standalone entry for sheet-cam.html. The SheetCam component itself is also
// imported by the main app (embedded in the Winamp UI), so the bootstrap must
// live here and not inside sheet-cam.tsx.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SheetCam />
  </React.StrictMode>
);
