#!/usr/bin/env node
// MCP server for Claude Desktop, Claude Code and other MCP clients, over stdio.
//
//   CHIPS_VOICE_URL   the station server, e.g. https://radio.example.com
//   CHIPS_VOICE_KEY   its API key (the server's API_KEY)
//   MCP_READ_ONLY     "true" to offer only the tools that look and never act
//
// Add it to a client, for example Claude Code:
//   claude mcp add chips-voice -e CHIPS_VOICE_URL=https://radio.example.com -e CHIPS_VOICE_KEY=... -- node /path/to/chips-voice/googleTextToSpeech1/mcp/stdio.js
// Logging goes to stderr only: stdout belongs to the protocol.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createStationClient } = require('../lib/station-client');
const { registerTools } = require('../lib/mcp-tools');

async function main() {
  const client = createStationClient({ baseUrl: process.env.CHIPS_VOICE_URL, key: process.env.CHIPS_VOICE_KEY });
  const server = new McpServer({ name: 'chips-voice', version: '1.0.0' });
  registerTools(server, client, { readOnly: process.env.MCP_READ_ONLY === 'true' });
  await server.connect(new StdioServerTransport());
  console.error('chips-voice MCP server ready');
}

main().catch((err) => {
  console.error(`chips-voice MCP server failed to start: ${err.message}`);
  process.exit(1);
});
