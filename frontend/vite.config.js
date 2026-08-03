import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Leaflet + its plugins (markercluster/heat/velocity) are loaded as plain
// <script> tags in index.html rather than npm packages -- see
// src/map/leafletGlobal.js for why. Nothing here needs to know about that;
// Vite just bundles the React app and leaves those tags alone.
export default defineConfig({
  plugins: [react()],
  server: {
    // Lets `npm run dev` run standalone against an already-running backend
    // (`python -m backend.app` on 8000) with live HMR for the React side,
    // instead of needing a full `npm run build` for every change.
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
