import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchMock } from "./helpers/fetch-mock";

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.reset());

describe("fetchMock", () => {
  it("answers a matching request with a JSON reply", async () => {
    fetchMock.intercept({ url: "https://api.example.com/v1/items", reply: { status: 201, json: { ok: true } } });
    const res = await fetch("https://api.example.com/v1/items");
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers with a plain body and custom headers", async () => {
    fetchMock.intercept({ url: "https://example.com/page", reply: { body: "<p>hi</p>", headers: { "content-type": "text/html" } } });
    const res = await fetch("https://example.com/page");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("<p>hi</p>");
  });

  it("matches the method when one is given and any method when it is not", async () => {
    fetchMock.intercept({ method: "POST", url: "https://example.com/a", reply: { json: { via: "post" } } });
    fetchMock.intercept({ url: "https://example.com/b", reply: { json: { via: "any" } }, times: 2 });
    await expect(fetch("https://example.com/a")).rejects.toThrow("GET https://example.com/a");
    expect(await (await fetch("https://example.com/a", { method: "POST" })).json()).toEqual({ via: "post" });
    expect(await (await fetch("https://example.com/b", { method: "DELETE" })).json()).toEqual({ via: "any" });
    expect(await (await fetch("https://example.com/b")).json()).toEqual({ via: "any" });
  });

  it("matches a RegExp against the full URL, query string included", async () => {
    fetchMock.intercept({ url: /^https:\/\/example\.com\/search\?q=/, reply: { json: { hits: 3 } } });
    const res = await fetch("https://example.com/search?q=fees");
    expect(await res.json()).toEqual({ hits: 3 });
  });

  it("uses each interceptor once by default, in order, and a persistent one with times: Infinity", async () => {
    fetchMock.intercept({ url: "https://example.com/x", reply: { body: "first" } });
    fetchMock.intercept({ url: "https://example.com/x", reply: { body: "second" } });
    fetchMock.intercept({ url: "https://example.com/y", reply: { body: "forever" }, times: Infinity });
    expect(await (await fetch("https://example.com/x")).text()).toBe("first");
    expect(await (await fetch("https://example.com/x")).text()).toBe("second");
    await expect(fetch("https://example.com/x")).rejects.toThrow("no interceptor");
    for (let i = 0; i < 5; i++) expect(await (await fetch("https://example.com/y")).text()).toBe("forever");
  });

  it("honours times: n", async () => {
    fetchMock.intercept({ url: "https://example.com/z", reply: { body: "ok" }, times: 2 });
    await fetch("https://example.com/z");
    await fetch("https://example.com/z");
    await expect(fetch("https://example.com/z")).rejects.toThrow("no interceptor");
  });

  it("throws on a request nothing intercepts, naming the method and URL", async () => {
    await expect(fetch("https://api.tinyfish.ai/v1/runs", { method: "POST", body: "{}" })).rejects.toThrow(
      "POST https://api.tinyfish.ai/v1/runs",
    );
  });

  it("calls a reply function with the request and its parsed body", async () => {
    fetchMock.intercept({
      method: "POST",
      url: "https://example.com/echo",
      reply: async (req, body) => Response.json({ method: req.method, got: body }, { status: 202 }),
    });
    const res = await fetch("https://example.com/echo", { method: "POST", body: JSON.stringify({ n: 1 }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ method: "POST", got: { n: 1 } });
  });

  it("records every call: JSON body parsed, else text, else null, unmatched calls included", async () => {
    fetchMock.intercept({ url: /example\.com/, reply: { body: "" }, times: Infinity });
    await fetch("https://example.com/json", { method: "POST", body: '{"a":1}' });
    await fetch("https://example.com/text", { method: "PUT", body: "plain words" });
    await fetch("https://example.com/none");
    await fetch("https://nowhere.test/").catch(() => {});
    expect(fetchMock.calls).toEqual([
      { method: "POST", url: "https://example.com/json", body: { a: 1 } },
      { method: "PUT", url: "https://example.com/text", body: "plain words" },
      { method: "GET", url: "https://example.com/none", body: null },
      { method: "GET", url: "https://nowhere.test/", body: null },
    ]);
  });

  it("accepts fetch(url, init), fetch(Request) and fetch(URL)", async () => {
    fetchMock.intercept({ url: "https://example.com/p", reply: { body: "ok" }, times: Infinity });
    await fetch("https://example.com/p", { method: "POST", body: "[1]" });
    await fetch(new Request("https://example.com/p", { method: "PATCH", body: '{"b":2}' }));
    await fetch(new URL("https://example.com/p"));
    expect(fetchMock.calls).toEqual([
      { method: "POST", url: "https://example.com/p", body: [1] },
      { method: "PATCH", url: "https://example.com/p", body: { b: 2 } },
      { method: "GET", url: "https://example.com/p", body: null },
    ]);
  });

  it("reset clears interceptors and calls and puts the real fetch back", async () => {
    const mocked = globalThis.fetch;
    fetchMock.intercept({ url: "https://example.com/r", reply: { body: "ok" } });
    await fetch("https://example.com/r");
    fetchMock.reset();
    expect(fetchMock.calls).toEqual([]);
    expect(globalThis.fetch).not.toBe(mocked);
    fetchMock.activate();
    await expect(fetch("https://example.com/r")).rejects.toThrow("no interceptor");
  });
});
