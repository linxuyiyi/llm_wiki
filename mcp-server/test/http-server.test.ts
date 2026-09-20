import assert from "node:assert/strict"
import test from "node:test"
import { getLanIpv4Addresses, parseMcpLaunchOptions } from "../src/http-server.js"

test("HTTP transport defaults stay local", () => {
  const parsed = parseMcpLaunchOptions(["--transport", "http"], {})
  assert.equal(parsed.transport, "http")
  assert.equal(parsed.http.host, "127.0.0.1")
  assert.equal(parsed.http.port, 8080)
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
      { address: "192.168.10.8", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.10.8/24" },
      { address: "fe80::1", netmask: "ffff::", family: "IPv6", mac: "", internal: false, cidr: "fe80::1/64", scopeid: 0 },
    ],
    Loopback: [
      { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: "127.0.0.1/8" },
    ],
  })
  assert.deepEqual(addresses, ["192.168.10.8"])
})
