/**
 * Remote MCP transport for the Claude connector (Streamable HTTP).
 *
 * Stateless: a fresh McpServer + transport per request, so there is no shared
 * mutable state to leak between users. Each user is authenticated by the OAuth
 * Bearer they present, which is forwarded (via withCredential) to the Diagrams
 * API on every tool call — this service holds no secrets and no session state.
 *
 * Auth handshake (MCP authorization spec): an unauthenticated request gets a 401
 * with a WWW-Authenticate header pointing at the protected-resource metadata,
 * which names the authorization server. Claude then runs OAuth and retries.
 */

import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer } from "./index.js";
import { withCredential } from "./client.js";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL || "https://mcp.diagrams.so").replace(/\/+$/, "");
const ISSUER = (process.env.OAUTH_ISSUER || "https://api.diagrams.so").replace(/\/+$/, "");
const SCOPES = "diagrams:read diagrams:write gallery:read usage:read meta:read";
const RESOURCE = `${PUBLIC_URL}/mcp`;
const WWW_AUTHENTICATE =
  `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource", ` +
  `scope="${SCOPES}"`;

function protectedResourceMetadata() {
  // RFC 9728. `resource` MUST equal the MCP URL exactly as the user enters it.
  return {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES.split(" "),
  };
}

function extractBearer(req: Request): string | null {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    const t = h.slice(7).trim();
    return t || null;
  }
  return null;
}

export function buildApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  const prm = (_req: Request, res: Response) => res.json(protectedResourceMetadata());
  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/mcp", prm);
  app.get("/health", (_req: Request, res: Response) => res.type("text/plain").send("ok\n"));

  const handleMcp = async (req: Request, res: Response) => {
    const token = extractBearer(req);
    if (!token) {
      // 401 (never a 200-wrapped tool error) so Claude shows the Connect card.
      res
        .status(401)
        .set("WWW-Authenticate", WWW_AUTHENTICATE)
        .json({ error: "invalid_token", error_description: "Authentication required" });
      return;
    }
    // Stateless: fresh server + transport per request.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createServer();
    await server.connect(transport);
    // Forward THIS user's Bearer to the API for every call this request makes.
    await withCredential(token, () => transport.handleRequest(req, res, req.body));
    res.on("close", () => {
      transport.close();
      server.close();
    });
  };

  app.post("/mcp", (req: Request, res: Response) => {
    handleMcp(req, res).catch((err) => {
      console.error("mcp request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    });
  });

  return app;
}

// Start listening unless a test disables it (tests import buildApp() directly).
if (process.env.MCP_HTTP_START !== "0") {
  buildApp().listen(PORT, () => {
    console.error(`diagrams-so remote MCP (Streamable HTTP) on :${PORT}  resource=${RESOURCE}`);
  });
}
