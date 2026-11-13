import "@/styles/index.css";
import { QueryClient } from "@tanstack/react-query";
import { createHashHistory } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { detectSnapshot, startOnReview } from "@/api/static";
import { isBlocking } from "@/components/shell/StateBanner";
import { createAppRouter } from "@/router";

async function main() {
  // A hosted PR snapshot (data/manifest.json beside index.html) has no server behind it: detect it before
  // the first render, so apiGet, events and the router's default route (spec §7) all start out right.
  const snapshot = await detectSnapshot();

  const queryClient = new QueryClient({
    // The map changes only when files change; SSE (Task 4) invalidates queries, so no polling or focus refetch.
    // A lost session or an unusable map (401/409) will not fix itself on a retry: show its state at once.
    defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: (n, err) => !isBlocking(err) && n < 1 } },
  });
  // A bare link to a snapshot opens on Review (spec §7); "/" itself stays Home for the rail.
  if (snapshot) startOnReview();
  // A snapshot has no server to serve clean paths from GitHub Pages, so it routes by the URL hash instead.
  const router = createAppRouter({ queryClient, ...(snapshot ? { history: createHashHistory() } : {}) });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App router={router} queryClient={queryClient} />
    </StrictMode>,
  );
}

void main();
