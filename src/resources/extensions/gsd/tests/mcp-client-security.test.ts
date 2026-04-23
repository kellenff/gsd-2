import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  _buildMcpChildEnvForTest,
  _buildMcpTrustConfirmOptionsForTest,
} from "../../mcp-client/index.ts";

test("MCP stdio child env only includes safe inherited keys plus explicit config env", () => {
  const previousSecret = process.env.SECRET_MCP_TEST_TOKEN;
  const previousPath = process.env.PATH;
  try {
    process.env.SECRET_MCP_TEST_TOKEN = "should-not-leak";
    process.env.PATH = "/usr/bin";

    const env = _buildMcpChildEnvForTest({
      EXPLICIT_TOKEN: "${SECRET_MCP_TEST_TOKEN}",
      PLAIN_VALUE: "ok",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.SECRET_MCP_TEST_TOKEN, undefined);
    assert.equal(env.EXPLICIT_TOKEN, "should-not-leak");
    assert.equal(env.PLAIN_VALUE, "ok");
  } finally {
    if (previousSecret === undefined) delete process.env.SECRET_MCP_TEST_TOKEN;
    else process.env.SECRET_MCP_TEST_TOKEN = previousSecret;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("MCP stdio trust confirmation is abort-aware", () => {
  const controller = new AbortController();
  const options = _buildMcpTrustConfirmOptionsForTest(controller.signal);

  assert.equal(options.timeout, 120_000);
  assert.equal(options.signal, controller.signal);
});

test("MCP client uses a single in-flight connection per canonical server", () => {
  const source = readFileSync(new URL("../../mcp-client/index.ts", import.meta.url), "utf8");

  assert.match(source, /const pendingConnections = new Map<string, Promise<Client>>\(\)/);
  assert.match(source, /const pending = pendingConnections\.get\(config\.name\)/);
  assert.match(source, /pendingConnections\.set\(config\.name, connectionPromise\)/);
  assert.match(source, /pendingConnections\.delete\(config\.name\)/);
  assert.match(source, /env: config\.env \?\? \{\}/);
});

test("MCP stdio trust is persisted only after a successful connection", () => {
  const source = readFileSync(new URL("../../mcp-client/index.ts", import.meta.url), "utf8");
  const connectIndex = source.indexOf("await client.connect(transport");
  const trustIndex = source.indexOf("trustedStdioServers.add(approvedTrustKey)");

  assert.ok(connectIndex > -1, "connectServer should await client.connect");
  assert.ok(trustIndex > connectIndex, "trust should be recorded after client.connect succeeds");
  assert.doesNotMatch(source, /assertTrustedStdioServer[\s\S]*trustedStdioServers\.add\(trustKey\)/);
});

test("MCP client closes transports after failed connection attempts", () => {
  const source = readFileSync(new URL("../../mcp-client/index.ts", import.meta.url), "utf8");

  assert.match(source, /catch \(err\) \{[\s\S]*await transport\.close\(\)/);
  assert.match(source, /catch \(err\) \{[\s\S]*await client\.close\(\)/);
  assert.match(source, /catch \(err\) \{[\s\S]*throw err/);
});

test("MCP client clears process-local trust and closes transports on session cleanup", () => {
  const source = readFileSync(new URL("../../mcp-client/index.ts", import.meta.url), "utf8");

  assert.match(source, /async function closeAll\(\)[\s\S]*await conn\.transport\.close\(\)/);
  assert.match(source, /async function closeAll\(\)[\s\S]*pendingConnections\.clear\(\)/);
  assert.match(source, /async function closeAll\(\)[\s\S]*trustedStdioServers\.clear\(\)/);
});
