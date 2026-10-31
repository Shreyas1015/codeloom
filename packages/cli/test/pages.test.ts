import { describe, expect, it } from "vitest";
import { detectPages } from "../src/adapters/pages.js";
import { ctxIn, ctxWith, parsed } from "./adapter-helpers.js";

const next = ctxWith("next", "react");
const routes = (rel: string, code = "", ctx = next) => detectPages(parsed(rel, code), ctx).map((p) => p.route);

describe("detectPages", () => {
  it("reads Next.js app router pages", () => {
    expect(routes("app/page.tsx")).toEqual(["/"]);
    expect(routes("src/app/(shop)/customers/[id]/page.tsx")).toEqual(["/customers/:id"]);
    expect(routes("app/customers/new/layout.tsx")).toEqual([]);
  });

  it("reads Next.js pages router pages, skipping api and special files", () => {
    expect(routes("pages/index.tsx")).toEqual(["/"]);
    expect(routes("pages/orders/[id].tsx")).toEqual(["/orders/:id"]);
    expect(routes("pages/_app.tsx")).toEqual([]);
    expect(routes("pages/api/health.ts")).toEqual([]);
  });

  it("ignores Next.js rules when next is not a dependency", () => {
    expect(routes("app/page.tsx", "", ctxWith("react"))).toEqual([]);
  });

  it("reads React Router JSX and object routes, joining nested paths", () => {
    const ctx = ctxWith("react-router-dom");
    const jsx = `
      export const App = () => (
        <Routes>
          <Route path="/orders" element={<Orders />}>
            <Route path=":id" element={<Order />} />
          </Route>
        </Routes>
      );`;
    expect(routes("src/App.tsx", jsx, ctx)).toEqual(["/orders", "/orders/:id"]);
    const objects = `
      const router = createBrowserRouter([
        { path: "/", element: <Home />, children: [{ path: "settings", element: <Settings /> }] },
      ]);`;
    expect(routes("src/router.tsx", objects, ctx)).toEqual(["/", "/settings"]);
  });

  it("treats a JSX index route as a page at its parent's path", () => {
    const ctx = ctxWith("react-router-dom");
    const jsx = `
      export const App = () => (
        <Route path="/orders" element={<L />}>
          <Route index element={<List />} />
          <Route path=":id" element={<O />} />
        </Route>
      );`;
    expect(routes("src/App.tsx", jsx, ctx)).toEqual(["/orders", "/orders", "/orders/:id"]);
  });

  it("treats an object index route as a page at its parent's path", () => {
    const ctx = ctxWith("react-router-dom");
    const objects = `
      const router = createBrowserRouter([
        { path: "/", element: <Root />, children: [{ index: true, element: <Home /> }, { path: "about", element: <About /> }] },
      ]);`;
    expect(routes("src/router.tsx", objects, ctx)).toEqual(["/", "/", "/about"]);
  });

  it("ignores object literals that are not inside a route-config array", () => {
    const ctx = ctxWith("react-router-dom");
    const code = `
      const menu = [{ path: "/settings", children: [{ path: "profile" }] }];
      const breadcrumbs = { path: "/x", element: "y" };`;
    expect(routes("src/nav.tsx", code, ctx)).toEqual([]);
  });

  it("recognizes object routes in an array assigned to a *routes/*Routes variable", () => {
    const ctx = ctxWith("react-router-dom");
    const code = `export const appRoutes = [{ path: "/a", element: <A /> }];`;
    expect(routes("src/routes.tsx", code, ctx)).toEqual(["/a"]);
  });

  it("matches Next.js folders only directly under the file's package root", () => {
    const pkg = ctxIn("packages/app", "next", "react");
    expect(routes("packages/app/src/app/dashboard/page.tsx", "", pkg)).toEqual(["/dashboard"]);
    expect(routes("packages/app/pages/orders/[id].tsx", "", pkg)).toEqual(["/orders/:id"]);
    expect(routes("packages/app/src/features/app/page.tsx", "", pkg)).toEqual([]);
    expect(routes("src/features/pages/list.tsx")).toEqual([]);
  });

  it("does not treat src/pages in a non-Next package as Next pages", () => {
    expect(routes("apps/spa/src/pages/Dashboard.tsx", "", ctxIn("apps/spa", "react"))).toEqual([]);
  });
  it("records the React Router page component and where it is imported from", () => {
    const ctx = ctxWith("react-router-dom");
    const jsx = `
      import { Customers } from "./customers";
      import Orders from "./orders";
      export const App = () => (
        <Routes>
          <Route path="/customers" element={<Customers />} />
          <Route path="/orders" element={<Orders.Page />} />
          <Route path="/raw" element={renderRaw()} />
        </Routes>
      );`;
    const pages = detectPages(parsed("src/App.tsx", jsx), ctx);
    expect(pages.map((p) => [p.route, p.component])).toEqual([
      ["/customers", { name: "Customers", importSource: "./customers" }],
      ["/orders", { name: "Orders.Page", importSource: "./orders" }],
      ["/raw", undefined],
    ]);
    const objects = `
      import Home from "./home";
      const router = createBrowserRouter([
        { path: "/", Component: Home, children: [{ path: "about", element: <About /> }] },
      ]);`;
    expect(detectPages(parsed("src/router.tsx", objects), ctx).map((p) => [p.route, p.component])).toEqual([
      ["/", { name: "Home", importSource: "./home" }],
      ["/about", { name: "About" }],
    ]);
  });
});
