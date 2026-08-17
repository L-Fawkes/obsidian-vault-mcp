import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---- Config (set these as environment variables on Render) ----
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;       // fine-grained PAT, "Contents: Read-only" on the vault repo
const GITHUB_OWNER = process.env.GITHUB_OWNER;        // your GitHub username
const GITHUB_REPO = process.env.GITHUB_REPO;          // the vault repo name
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET; // optional: simple bearer token to keep randoms out

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error("Missing required env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO");
  process.exit(1);
}

const GH_API = "https://api.github.com";
const ghHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "obsidian-vault-mcp",
};

// ---- Simple in-memory cache (avoids hammering GitHub's API on every tool call) ----
let treeCache = { at: 0, files: [] };
let fileCache = new Map(); // path -> { at, content }
const TREE_TTL_MS = 60 * 1000;      // 1 minute
const FILE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

async function ghFetch(url) {
  const res = await fetch(url, { headers: ghHeaders });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function listVaultFiles() {
  const now = Date.now();
  if (now - treeCache.at < TREE_TTL_MS && treeCache.files.length) {
    return treeCache.files;
  }
  const data = await ghFetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`
  );
  const files = (data.tree || [])
    .filter((item) => item.type === "blob" && item.path.endsWith(".md"))
    .map((item) => item.path);
  treeCache = { at: now, files };
  return files;
}

async function readVaultFile(path) {
  const now = Date.now();
  const cached = fileCache.get(path);
  if (cached && now - cached.at < FILE_TTL_MS) {
    return cached.content;
  }
  const data = await ghFetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${GITHUB_BRANCH}`
  );
  if (!data.content) throw new Error(`No content returned for ${path}`);
  const content = Buffer.from(data.content, data.encoding || "base64").toString("utf-8");
  fileCache.set(path, { at: now, content });
  return content;
}

// Looks up the current blob SHA for a path, or null if it doesn't exist yet.
// Needed because GitHub's "create/update file" endpoint requires the SHA of
// the file being replaced (and must be omitted when creating a new file).
async function getFileSha(path) {
  const res = await fetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${GITHUB_BRANCH}`,
    { headers: ghHeaders }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${path}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.sha || null;
}

function invalidateCaches(path) {
  fileCache.delete(path);
  treeCache = { at: 0, files: [] }; // force a fresh tree listing next call
}

async function writeVaultFile(path, content, message) {
  const sha = await getFileSha(path);
  const body = {
    message: message || `Update ${path} via Claude`,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`,
    { method: "PUT", headers: { ...ghHeaders, "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} writing ${path}: ${errBody.slice(0, 300)}`);
  }
  invalidateCaches(path);
  return sha ? "updated" : "created";
}

async function deleteVaultFile(path, message) {
  const sha = await getFileSha(path);
  if (!sha) throw new Error(`'${path}' does not exist`);
  const res = await fetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: "DELETE",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ message: message || `Delete ${path} via Claude`, sha, branch: GITHUB_BRANCH }),
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} deleting ${path}: ${errBody.slice(0, 300)}`);
  }
  invalidateCaches(path);
}

// ---- MCP server + tools ----
function buildServer() {
  const server = new McpServer({ name: "obsidian-vault", version: "1.0.0" });

  server.tool(
    "list_notes",
    "List all Markdown note paths in the Obsidian vault, optionally filtered to a folder prefix.",
    { folder: z.string().optional().describe("Only list notes under this folder path, e.g. 'Projects/'") },
    async ({ folder }) => {
      const files = await listVaultFiles();
      const filtered = folder ? files.filter((f) => f.startsWith(folder)) : files;
      return {
        content: [{ type: "text", text: filtered.length ? filtered.join("\n") : "(no notes found)" }],
      };
    }
  );

  server.tool(
    "read_note",
    "Read the full content of one note by its exact path (as returned by list_notes or search_notes).",
    { path: z.string().describe("Path to the note, e.g. 'Daily/2026-08-17.md'") },
    async ({ path }) => {
      try {
        const content = await readVaultFile(path);
        return { content: [{ type: "text", text: content }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error reading '${path}': ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "search_notes",
    "Full-text search across all notes in the vault. Returns matching file paths with a snippet of context per match.",
    {
      query: z.string().describe("Text to search for (case-insensitive, plain substring match)"),
      max_results: z.number().int().min(1).max(50).optional().describe("Max number of matching notes to return (default 15)"),
    },
    async ({ query, max_results }) => {
      const limit = max_results ?? 15;
      const files = await listVaultFiles();
      const q = query.toLowerCase();
      const hits = [];

      for (const path of files) {
        if (hits.length >= limit) break;
        let content;
        try {
          content = await readVaultFile(path);
        } catch {
          continue;
        }
        const lower = content.toLowerCase();
        if (!lower.includes(q)) continue;

        const idx = lower.indexOf(q);
        const start = Math.max(0, idx - 60);
        const end = Math.min(content.length, idx + q.length + 60);
        const snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
        hits.push(`- ${path}: ...${snippet}...`);
      }

      return {
        content: [{ type: "text", text: hits.length ? hits.join("\n") : `No notes matched "${query}".` }],
      };
    }
  );

  server.tool(
    "write_note",
    "Create a new note or overwrite an existing one in the vault. Commits directly to the branch and shows up on your devices next Obsidian Git sync.",
    {
      path: z.string().describe("Path for the note, e.g. 'Ideas/new-idea.md'. Create parent folders implicitly by including them in the path."),
      content: z.string().describe("Full Markdown content of the note (this replaces the entire file if it already exists)."),
      commit_message: z.string().optional().describe("Optional git commit message."),
    },
    async ({ path, content, commit_message }) => {
      try {
        const result = await writeVaultFile(path, content, commit_message);
        return { content: [{ type: "text", text: `Note ${result}: ${path}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error writing '${path}': ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "delete_note",
    "Delete a note from the vault. This is permanent (removed via a git commit) — confirm with the user before calling this.",
    {
      path: z.string().describe("Path of the note to delete."),
      commit_message: z.string().optional().describe("Optional git commit message."),
    },
    async ({ path, commit_message }) => {
      try {
        await deleteVaultFile(path, commit_message);
        return { content: [{ type: "text", text: `Deleted: ${path}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error deleting '${path}': ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// ---- HTTP transport (stateless, one MCP server instance per request) ----
const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) => res.send("Obsidian vault MCP server is running."));

app.post("/mcp", async (req, res) => {
  if (MCP_SHARED_SECRET) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${MCP_SHARED_SECRET}`) {
      return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    }
  }
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Obsidian vault MCP server listening on port ${PORT}`);
  console.log(`Repo: ${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}`);
});
