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
import { SettingsPage } from "./pages/SettingsPage";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

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

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage
});

const routeTree = rootRoute.addChildren([
  inboxRoute,
  pullRequestRoute,
  settingsRoute
]);

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
