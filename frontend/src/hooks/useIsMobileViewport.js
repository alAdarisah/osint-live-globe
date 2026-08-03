import { useEffect, useState } from "react";

// Matches the breakpoint in the mobile media query in style.css -- keep the
// two in sync if it ever changes.
const QUERY = "(max-width: 700px)";

export function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
