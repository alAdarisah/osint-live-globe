import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./style.css";

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

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </React.StrictMode>
);
