// The same MCP tools over HTTP (Streamable HTTP, stateless), at POST /mcp, for MCP clients that connect to a URL.
// Mount it AFTER the login check: it requires the API key, a login token, or the internal key, like the rest of the API.
// Each request gets its own server instance, so there is no session state to leak between callers.
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerTools } = require('../lib/mcp-tools');

function createMcpRoutes({ clientFor, readOnly = false }) {
  const router = express.Router();

  router.post('/mcp', async (req, res) => {
    try {
      const server = new McpServer({ name: 'chips-voice', version: '1.0.0' });
      // Calls made through the tools carry the same credential the MCP caller presented.
      registerTools(server, clientFor(req), { readOnly });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('mcp:', err.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });

  const notAllowed = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'use POST' }, id: null });
  router.get('/mcp', notAllowed);
  router.delete('/mcp', notAllowed);
  return router;
}

module.exports = { createMcpRoutes };
