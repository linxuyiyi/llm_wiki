import assert from "node:assert/strict"
import test from "node:test"
import { getLanIpv4Addresses, parseMcpLaunchOptions } from "../src/http-server.js"

test("HTTP transport defaults stay local", () => {
  const parsed = parseMcpLaunchOptions(["--transport", "http"], {})
  assert.equal(parsed.transport, "http")
  assert.equal(parsed.http.host, "127.0.0.1")
  assert.equal(parsed.http.port, 19898)
  assert.equal(parsed.http.path, "/mcp")
})

test("HTTP transport accepts LAN binding and env configuration", () => {
  const parsed = parseMcpLaunchOptions([], {
    LLM_WIKI_MCP_TRANSPORT: "http",
    LLM_WIKI_MCP_HOST: "0.0.0.0",
    LLM_WIKI_MCP_PORT: "18080",
    LLM_WIKI_MCP_PATH: "agent/mcp/",
    LLM_WIKI_MCP_AUTH_TOKEN: "secret",
  })
  assert.equal(parsed.transport, "http")
  assert.deepEqual(parsed.http, {
    host: "0.0.0.0",
    port: 18080,
    path: "/agent/mcp",
    authToken: "secret",
  })
})

test("LAN address detection returns only non-loopback IPv4 addresses", () => {
  const addresses = getLanIpv4Addresses({
    Ethernet: [
      { address: "192.168.10.8", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    Loopback: [
      { address: "127.0.0.1", family: "IPv4", internal: true },
    ],
  })
  assert.deepEqual(addresses, ["192.168.10.8"])
})
