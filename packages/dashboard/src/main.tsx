import "@/styles/index.css";
import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { isBlocking } from "@/components/shell/StateBanner";
import { createAppRouter } from "@/router";

const queryClient = new QueryClient({
  // The map changes only when files change; SSE (Task 4) invalidates queries, so no polling or focus refetch.
  // A lost session or an unusable map (401/409) will not fix itself on a retry: show its state at once.
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: (n, err) => !isBlocking(err) && n < 1 } },
});
const router = createAppRouter({ queryClient });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
