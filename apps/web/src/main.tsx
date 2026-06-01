import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InboxPage } from "./pages/InboxPage";
import { PullRequestPage } from "./pages/PullRequestPage";
import "./styles.css";

const queryClient = new QueryClient();

const rootRoute = createRootRoute({
  component: () => (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          PR Tracker
        </Link>
        <nav className="nav">
          <Link to="/" activeProps={{ className: "active" }}>
            Review inbox
          </Link>
        </nav>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
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
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
