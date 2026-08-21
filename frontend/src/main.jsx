import React from "react";
import ReactDOM from "react-dom/client";
import { prune as prunePayloadCache } from "./utils/payloadStore.js";
import App from "./App";
import "./style.css";
// After style.css, not @import-ed from the top of it. chrome.css restyles
// surfaces style.css already has same-specificity rules for (#map, #clock, the
// Leaflet popup shell), and an @import would place it *first* in the cascade,
// where every one of those rules would lose to the thing it is replacing.
import "./chrome.css";

// A render crash used to leave a silent blank page with nothing on screen
// to tell you what happened -- this surfaces the error/stack instead so a
// bug is visible immediately rather than needing devtools open to notice.
class CrashScreen extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("OSINT Live Globe crashed:", error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <pre style={{ color: "#ff6b6b", background: "#1a1a1a", padding: 20, whiteSpace: "pre-wrap", fontSize: 13 }}>
          {String(this.state.error?.stack || this.state.error)}
        </pre>
      );
    }
    return this.props.children;
  }
}

// Housekeeping for the persistent payload cache, well after the map has painted.
// A cursor walk over stored responses is not something to put in front of the
// first frame, and nothing depends on its result -- see utils/payloadStore.js.
if (typeof requestIdleCallback === "function") {
  requestIdleCallback(() => { prunePayloadCache(); }, { timeout: 30000 });
} else {
  setTimeout(() => { prunePayloadCache(); }, 15000);
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </React.StrictMode>
);
