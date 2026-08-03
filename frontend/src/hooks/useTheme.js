import { useCallback, useEffect, useState } from "react";

const THEME_KEY = "osint-theme";

function initialTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  return saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}

export function useTheme() {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.setAttribute("content", theme === "light" ? "#eef3f6" : "#001018");
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
