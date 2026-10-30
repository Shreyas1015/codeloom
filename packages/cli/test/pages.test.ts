import { describe, expect, it } from "vitest";
import { detectPages } from "../src/adapters/pages.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

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
});
