import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppFrame } from "./app/AppFrame";
import { TooltipProvider } from "./components/ui/tooltip";
import { InboxPage } from "./pages/InboxPage";
import { PullRequestPage } from "./pages/PullRequestPage";
import "./index.css";

const queryClient = new QueryClient();

const rootRoute = createRootRoute({
  component: AppFrame
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: InboxPage
});

const pullRequestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pull-requests/$pullRequestId",
  component: PullRequestPage
});

const routeTree = rootRoute.addChildren([inboxRoute, pullRequestRoute]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>
);
