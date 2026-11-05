import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { finalizeEndpoints, runAdapters } from "../src/adapters/run.js";
import { buildFileCodeIndex } from "../src/linker/code-index.js";
import type { RepoCodeIndex } from "../src/linker/code-index.js";
import { linkUi } from "../src/linker/link.js";
import { createCallResolver } from "../src/linker/resolve-calls.js";
import type { CallResolver, SymbolRef } from "../src/linker/resolve-calls.js";
import { resolveImport } from "../src/indexer/resolve-imports.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import type { EndpointsFile, HttpMethod, UiPage } from "../src/store/schemas.js";
import { ctxWith, parsed } from "./adapter-helpers.js";

// v0.2a §4: Redux, class components. Every new hop is at best "param"; anything unresolvable stays unresolved.

function graphStub(): KnowledgeGraph {
  return {
    version: "1",
    project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
    nodes: [], edges: [], layers: [], tour: [],
  };
}

const ROUTER = "src/App.tsx";

/** A UI repo (`uiFiles`; its router `src/App.tsx` routes `/customers` to `CustomersPage`, imported from
 * ./pages/CustomersPage) linked against an API with `routes`. Each UI call as [call, route, page paths
 * "symbol(confidence)"]. */
function link(uiFiles: Record<string, string>, routes: Array<[HttpMethod, string]>): string[][] {
  const ctx = ctxWith("axios", "react", "react-router-dom", "react-redux", "@reduxjs/toolkit");
  const all: Record<string, string> = {
    [ROUTER]: "import CustomersPage from './pages/CustomersPage';\nexport const App = () => <Route path=\"/customers\" component={CustomersPage} />;\n",
    ...uiFiles,
  };
  const rels = Object.keys(all).sort();
  const files = new Set(rels);
  const ep = finalizeEndpoints("ui", rels.map((rel) => runAdapters(rel, all[rel]!, ctx)), (from, spec) => resolveImport(from, spec, files, []));
  const index: RepoCodeIndex = new Map(rels.map((rel) => [rel, buildFileCodeIndex(parsed(rel, all[rel]!))]));
  const pages: UiPage[] = ep.pages;
  const ui: RepoData = { ref: { id: "ui", path: "ui", role: "ui" }, abs: "/ws/ui", graph: graphStub(), endpoints: { ...ep, pages } };
  const apiRoutes: EndpointsFile["routes"] = routes.map(([method, path]) => ({
    method, path, handler: `${method} ${path}`, inline: true, framework: "express",
    at: { file: "src/app.ts", line: 1, symbol: `${method} ${path}` },
  }));
  const api: RepoData = {
    ref: { id: "api", path: "api", role: "api" }, abs: "/ws/api", graph: graphStub(),
    endpoints: {
      version: 2, repo: "api", pages: [], httpCalls: [], httpClients: [], mounts: [], dbAccess: [], tables: [], models: [], queues: [],
      routes: apiRoutes,
    },
  };
  const ws: WorkspaceData = { root: "/ws", name: "ws", repos: [ui, api], links: [] };
  const resolvers = new Map([["ui", createCallResolver({ repo: "ui", index, files, aliases: [] })]]);
  return linkUi({ ws, resolvers }).map((l) => [
    `${l.call.method} ${l.call.path}`,
    l.target.kind === "route" ? `${l.target.route.route.method} ${l.target.route.effectivePath}` : l.target.kind,
    ...l.pages.map((p) => p.path.map((s) => `${s.symbol}(${s.confidence})`).join(">")),
  ]);
}

function resolverOf(files: Record<string, string>): CallResolver {
  const index: RepoCodeIndex = new Map();
  for (const [rel, code] of Object.entries(files)) index.set(rel, buildFileCodeIndex(parsed(rel, code)));
  return createCallResolver({ repo: "ui", index, files: new Set(Object.keys(files)), aliases: [] });
}

const ref = (file: string, symbol: string): SymbolRef => ({ repo: "ui", file, symbol });

/** Every resolved call made by `symbol` in `file`, as "line:kind->file#symbol (confidence/via)". */
function callsOf(resolver: CallResolver, file: string, symbol: string): string[] {
  return resolver.callsFrom(ref(file, symbol)).map((c) =>
    `${c.site.line}:${c.site.kind ?? "call"}->${c.target.file}#${c.target.symbol} (${c.confidence}/${c.via})`);
}

const API = "src/api/customers.ts";
const PAGE = "src/pages/CustomersPage.tsx";
const apiFile = [
  "export async function loadCustomers() { return fetch('/customers'); }",
  "export async function saveCustomer(d: unknown) { return fetch('/customers', { method: 'POST' }); }",
  "export async function deleteCustomer(id: string) { return fetch(`/customers/${id}`, { method: 'DELETE' }); }",
  "",
].join("\n");

describe("class components: lifecycle methods and handlers are reached from the class's page", () => {
  it("componentDidMount, a bound method handler, a constructor arrow and a class-field arrow; connect()ed default export", () => {
    const page = [
      "import React from 'react';",
      "import { connect } from 'react-redux';",
      "import { loadCustomers, saveCustomer, deleteCustomer } from '../api/customers';",
      "class CustomersPage extends React.Component {",
      "  constructor(props) {",
      "    super(props);",
      "    this.handleSave = this.handleSave.bind(this);",
      "    this.remove = (id) => { deleteCustomer(id); };",
      "  }",
      "  componentDidMount() { loadCustomers(); }",
      "  handleSave() { saveCustomer({}); }",
      "  render() {",
      "    return <div><button onClick={this.handleSave} /><button onClick={() => this.remove('1')} /></div>;",
      "  }",
      "}",
      "export default connect((s) => s)(CustomersPage);",
    ].join("\n");
    expect(link({ [API]: apiFile, [PAGE]: page }, [["GET", "/customers"], ["POST", "/customers"], ["DELETE", "/customers/:id"]])).toEqual([
      ["GET /customers", "GET /customers", "CustomersPage(param)>CustomersPage.componentDidMount(exact)>loadCustomers(exact)"],
      ["POST /customers", "POST /customers", "CustomersPage(param)>CustomersPage.render(param)>CustomersPage.handleSave(exact)>saveCustomer(exact)"],
      ["DELETE /customers/:id", "DELETE /customers/:id", "CustomersPage(param)>CustomersPage.render(exact)>CustomersPage.remove(exact)>deleteCustomer(exact)"],
    ]);
  });

  it("lifecycle sites only for React classes; a static method or a plain class's render is not one", () => {
    const r = resolverOf({
      [PAGE]: [
        "import React, { PureComponent } from 'react';",
        "export class CustomersPage extends PureComponent {",
        "  static getDerivedStateFromProps() { return null; }",
        "  componentDidMount() {}",
        "  render() { return null; }",
        "}",
        "export class Report { render() { return ''; } }",
        "export class Favorites extends CustomersPage { componentWillMount() {} }",
      ].join("\n"),
    });
    expect(callsOf(r, PAGE, "CustomersPage")).toEqual([
      `4:lifecycle->${PAGE}#CustomersPage.componentDidMount (param/lifecycle)`,
      `5:lifecycle->${PAGE}#CustomersPage.render (param/lifecycle)`,
    ]);
    expect(callsOf(r, PAGE, "Report")).toEqual([]);
    expect(callsOf(r, PAGE, "Favorites")).toEqual([`8:lifecycle->${PAGE}#Favorites.componentWillMount (param/lifecycle)`]);
  });

  it("this.props.onX() follows the one function the JSX sites pass; two different ones, or none, stay unresolved", () => {
    const row = "src/components/CustomerRow.tsx";
    const r = resolverOf({
      [API]: apiFile,
      [row]: [
        "import React from 'react';",
        "export default class CustomerRow extends React.Component {",
        "  handleClick() { this.props.onRemove(this.props.id); }",
        "  handleOpen() { this.props.onOpen(); }",
        "  handleEdit() { this.props.onEdit(); }",
        "  render() { return <li onClick={this.handleClick} />; }",
        "}",
      ].join("\n"),
      [PAGE]: [
        "import React from 'react';",
        "import CustomerRow from '../components/CustomerRow';",
        "import { deleteCustomer, saveCustomer } from '../api/customers';",
        "export default class CustomersPage extends React.Component {",
        "  remove(id) { deleteCustomer(id); }",
        "  render() {",
        "    return <ul>",
        "      <CustomerRow id='1' onRemove={this.remove} onOpen={() => {}} onEdit={saveCustomer} />",
        "      <CustomerRow id='2' onRemove={this.remove} onEdit={deleteCustomer} />",
        "    </ul>;",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(callsOf(r, row, "CustomerRow.handleClick")).toEqual([`3:call->${PAGE}#CustomersPage.remove (param/jsx-prop)`]);
    expect(callsOf(r, row, "CustomerRow.handleOpen")).toEqual([]);
    expect(callsOf(r, row, "CustomerRow.handleEdit")).toEqual([]);
  });

  it("a prop handed on (onRemove={this.props.onRemove}) is followed to the function given further up", () => {
    const row = "src/components/Row.tsx";
    const list = "src/components/List.tsx";
    const r = resolverOf({
      [API]: apiFile,
      [row]: "import React from 'react';\nexport class Row extends React.Component {\n  click() { this.props.onRemove(); }\n}\n",
      [list]: "import React from 'react';\nimport { Row } from './Row';\nexport class List extends React.Component {\n  render() { return <Row onRemove={this.props.onRemove} />; }\n}\n",
      [PAGE]: [
        "import React from 'react';",
        "import { List } from '../components/List';",
        "import { deleteCustomer } from '../api/customers';",
        "export default function CustomersPage() {",
        "  return <List onRemove={deleteCustomer} />;",
        "}",
      ].join("\n"),
    });
    expect(callsOf(r, row, "Row.click")).toEqual([`3:call->${API}#deleteCustomer (param/jsx-prop)`]);
  });
});

describe("precision fixes found on realworld", () => {
  it("Promise.all() / JSON.parse() on an undeclared global is never guessed onto a same-named repo method", () => {
    const r = resolverOf({
      "src/agent.ts": "export const Articles = { all() { return fetch('/articles'); }, parse() { return 1; } };\n",
      [PAGE]: "export function load() {\n  Promise.all([]);\n  JSON.parse('{}');\n}\n",
    });
    expect(callsOf(r, PAGE, "load")).toEqual([]);
  });
});

describe("Redux", () => {
  it("connect(mapState, mapDispatchToProps): this.props.onX() / props.onX() reach the entry's inline arrow, line-precise", () => {
    const page = [
      "import React from 'react';",
      "import { connect } from 'react-redux';",
      "import { loadCustomers, saveCustomer } from '../api/customers';",
      "const mapDispatchToProps = dispatch => ({",
      "  onLoad: () => dispatch({ type: 'LOADED', payload: loadCustomers() }),",
      "  onSave: (c) =>",
      "    dispatch({ type: 'SAVED', payload: saveCustomer(c) }),",
      "});",
      "class CustomersPage extends React.Component {",
      "  componentWillUnmount() { this.props.onLoad(); }",
      "  save() { this.props.onSave({}); }",
      "  render() { return <button onClick={this.save} />; }",
      "}",
      "export default connect(null, mapDispatchToProps)(CustomersPage);",
    ].join("\n");
    expect(link({ [API]: apiFile, [PAGE]: page }, [["GET", "/customers"], ["POST", "/customers"]])).toEqual([
      ["GET /customers", "GET /customers", "CustomersPage(param)>CustomersPage.componentWillUnmount(param)>mapDispatchToProps(exact)>loadCustomers(exact)"],
      // Not through componentWillUnmount: its onLoad arrow is not the one that calls saveCustomer.
      ["POST /customers", "POST /customers", "CustomersPage(param)>CustomersPage.render(param)>CustomersPage.save(param)>mapDispatchToProps(exact)>saveCustomer(exact)"],
      ["DELETE /customers/:id", "unresolved"],
    ]);
  });

  it("an object mapDispatchToProps and props.onX() in a function component; unknown keys stay unresolved", () => {
    const r = resolverOf({
      [API]: apiFile,
      [PAGE]: [
        "import { connect } from 'react-redux';",
        "import { saveCustomer } from '../api/customers';",
        "const CustomersPage = (props) => {",
        "  const submit = () => props.onSave({});",
        "  props.onMissing();",
        "  return <form onSubmit={submit} />;",
        "};",
        "export default connect(null, { onSave: saveCustomer })(CustomersPage);",
      ].join("\n"),
    });
    expect(callsOf(r, PAGE, "submit")).toEqual([`4:call->${API}#saveCustomer (param/redux)`]);
    expect(callsOf(r, PAGE, "CustomersPage").filter((c) => c.startsWith("5:"))).toEqual([]);
  });

  it("dispatch(thunk(args)) reaches the thunk; createAsyncThunk's payload creator is reached at param", () => {
    const slice = "src/store/customers.ts";
    const page = [
      "import { useEffect } from 'react';",
      "import { useDispatch } from 'react-redux';",
      "import { fetchCustomers, removeCustomer } from '../store/customers';",
      "export default function CustomersPage() {",
      "  const dispatch = useDispatch();",
      "  useEffect(() => { dispatch(fetchCustomers()); }, []);",
      "  return <button onClick={() => dispatch(removeCustomer('1'))} />;",
      "}",
    ].join("\n");
    const sliceFile = [
      "import { createAsyncThunk } from '@reduxjs/toolkit';",
      "import axios from 'axios';",
      "export const fetchCustomers = createAsyncThunk('customers/fetch', async () => {",
      "  const res = await axios.get('/customers');",
      "  return res.data;",
      "});",
      "export const removeCustomer = (id: string) => async (dispatch: any) => {",
      "  await axios.delete(`/customers/${id}`);",
      "  dispatch({ type: 'removed', id });",
      "};",
    ].join("\n");
    expect(link({ [slice]: sliceFile, [PAGE]: page }, [["GET", "/customers"], ["DELETE", "/customers/:id"]])).toEqual([
      ["GET /customers", "GET /customers", "CustomersPage(param)>fetchCustomers(exact)"],
      ["DELETE /customers/:id", "DELETE /customers/:id", "CustomersPage(exact)>removeCustomer(exact)"],
    ]);
  });

  it("RTK Query: createApi endpoints are HTTP calls on the api's baseUrl; generated hooks are their call sites", () => {
    const apiTs = "src/services/customersApi.ts";
    const svc = [
      "import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';",
      "export const customersApi = createApi({",
      "  reducerPath: 'customersApi',",
      "  baseQuery: fetchBaseQuery({ baseUrl: '/api' }),",
      "  endpoints: (builder) => ({",
      "    getCustomer: builder.query({ query: (id) => `/customers/${id}` }),",
      "    listCustomers: builder.query({ query: () => 'customers' }),",
      "    addCustomer: builder.mutation({",
      "      query: (body) => ({ url: '/customers', method: 'POST', body }),",
      "    }),",
      "    deleteCustomer: builder.mutation({ query(id) { return { url: `/customers/${id}`, method: 'DELETE' }; } }),",
      "  }),",
      "});",
      "export const { useGetCustomerQuery, useListCustomersQuery, useAddCustomerMutation, useDeleteCustomerMutation } = customersApi;",
    ].join("\n");
    const page = [
      "import { useGetCustomerQuery, useAddCustomerMutation, customersApi } from '../services/customersApi';",
      "export default function CustomersPage() {",
      "  const { data } = useGetCustomerQuery('1');",
      "  const list = customersApi.useListCustomersQuery();",
      "  const [addCustomer] = useAddCustomerMutation();",
      "  const save = () => addCustomer({});",
      "  return <form onSubmit={save} />;",
      "}",
    ].join("\n");
    expect(link({ [apiTs]: svc, [PAGE]: page }, [
      ["GET", "/api/customers/:id"], ["GET", "/api/customers"], ["POST", "/api/customers"], ["DELETE", "/api/customers/:id"],
    ])).toEqual([
      ["GET /customers/:id", "GET /api/customers/:id", "CustomersPage(param)>customersApi.getCustomer(exact)"],
      ["GET /customers", "GET /api/customers", "CustomersPage(param)>customersApi.listCustomers(exact)"],
      // The shortest way: the page's own useAddCustomerMutation() call.
      ["POST /customers", "POST /api/customers", "CustomersPage(param)>customersApi.addCustomer(exact)"],
      ["DELETE /customers/:id", "DELETE /api/customers/:id"],
    ]);
    // The mutation's trigger (`const [addCustomer] = useAddCustomerMutation()`) is the endpoint too.
    const r = resolverOf({ [apiTs]: svc, [PAGE]: page });
    expect(callsOf(r, PAGE, "save")).toEqual([`6:call->${apiTs}#customersApi.addCustomer (param/rtk-hook)`]);
  });

  it("RTK Query stays out: a custom baseQuery, a hook name for a missing endpoint, a non-builder query", () => {
    const apiTs = "src/services/customersApi.ts";
    const svc = [
      "import { createApi } from '@reduxjs/toolkit/query/react';",
      "import { axiosBaseQuery } from './axiosBaseQuery';",
      "export const customersApi = createApi({",
      "  baseQuery: axiosBaseQuery(),",
      "  endpoints: (builder) => ({ getCustomer: builder.query({ query: (id) => `/customers/${id}` }) }),",
      "});",
      "export const { useGetCustomerQuery, useGetInvoiceQuery } = customersApi;",
      "export const other = { endpoints: (b) => ({ x: other.query({ query: () => '/x' }) }) };",
    ].join("\n");
    const ep = finalizeEndpoints("ui", [runAdapters(apiTs, svc, ctxWith("react"))]);
    expect(ep.httpCalls).toEqual([]);
    const r = resolverOf({
      [apiTs]: svc,
      [PAGE]: "import { useGetInvoiceQuery } from '../services/customersApi';\nexport default function P() { useGetInvoiceQuery(); }\n",
    });
    expect(callsOf(r, PAGE, "P")).toEqual([]);
  });
});

describe("HOC default-export unwrap confidence (final review §1)", () => {
  const USE = "src/run.ts";
  const callsFromRun = (impl: string): string[] =>
    callsOf(resolverOf({ "src/customer.ts": impl, [USE]: "import h from './customer';\nexport function run() { h(); }\n" }), USE, "run");

  it("an unknown wrapper unwraps at param, never exact", () => {
    expect(callsFromRun("function validator() {}\nexport default makeValidatedHandler(validator);\n"))
      .toEqual(["2:call->src/customer.ts#validator (param/import)"]);
  });

  it("known HOCs (with*, connect, memo, React.memo, forwardRef, compose, observer, inject) unwrap at exact", () => {
    for (const wrap of ["withAuth(Customer)", "connect(a, b)(Customer)", "memo(Customer)", "React.memo(Customer)", "forwardRef(Customer)",
      "compose(withAuth, withRouter)(Customer)", "observer(Customer)", "inject('store')(Customer)", "withRouter(connect(a)(Customer))"]) {
      expect(callsFromRun(`function Customer() {}\nexport default ${wrap};\n`), wrap).toEqual(["2:call->src/customer.ts#Customer (exact/import)"]);
    }
  });

  it("a known HOC around an unknown one is param; a wrapped non-function stays unresolved", () => {
    expect(callsFromRun("function Customer() {}\nexport default withAuth(makeInvoice(Customer));\n"))
      .toEqual(["2:call->src/customer.ts#Customer (param/import)"]);
    expect(callsFromRun("const invoice = 1;\nexport default withAuth(invoice);\n")).toEqual([]);
  });
});
