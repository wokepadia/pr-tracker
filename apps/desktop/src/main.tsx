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
import { AiDashboardPage } from "./pages/AiDashboardPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { PullRequestPage } from "./pages/PullRequestPage";
import { SettingsPage } from "./pages/SettingsPage";
import { installRendererErrorLogging } from "./lib/error-logging";
import "./index.css";

installRendererErrorLogging();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      // Reads come from local SQLite and only change after local mutations
      // or background syncs, both of which invalidate their queries
      // explicitly. A short stale time plus a long cache keeps screen
      // switches instant instead of refetching everything on every mount.
      staleTime: 30_000,
      gcTime: 30 * 60_000,
    },
    mutations: {
      retry: false,
    },
  },
});

const rootRoute = createRootRoute({
  component: AppFrame
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: AiDashboardPage
});

const pullRequestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pull-requests/$pullRequestId",
  component: PullRequestPage
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  pullRequestRoute,
  onboardingRoute,
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
