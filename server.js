import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import yaml from "js-yaml";

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

// Splits a note into { frontmatter: object, body: string }. Returns an empty
// frontmatter object if the note has none.
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  let frontmatter;
  try {
    frontmatter = yaml.load(match[1]) || {};
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body: match[2] };
}

function basenameNoExt(path) {
  const base = path.split("/").pop() || path;
  return base.replace(/\.md$/i, "");
}

function uniqueFolders(files) {
  const folders = new Set();
  for (const f of files) {
    const parts = f.split("/");
    parts.pop(); // drop filename
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      folders.add(acc);
    }
  }
  return [...folders].sort();
}

// ---- Graph data (produced by the graphify.yml GitHub Action) ----
let graphCache = { at: 0, data: null };
let reportCache = { at: 0, text: null };
const GRAPH_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadGraph() {
  const now = Date.now();
  if (graphCache.data && now - graphCache.at < GRAPH_TTL_MS) return graphCache.data;
  const data = await ghFetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/graphify-out/graph.json?ref=${GITHUB_BRANCH}`
  );
  const parsed = JSON.parse(Buffer.from(data.content, data.encoding || "base64").toString("utf-8"));
  graphCache = { at: now, data: parsed };
  return parsed;
}

async function loadGraphReport() {
  const now = Date.now();
  if (reportCache.text && now - reportCache.at < GRAPH_TTL_MS) return reportCache.text;
  const data = await ghFetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/graphify-out/GRAPH_REPORT.md?ref=${GITHUB_BRANCH}`
  );
  const text = Buffer.from(data.content, data.encoding || "base64").toString("utf-8");
  reportCache = { at: now, text };
  return text;
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

  server.tool(
    "append_note",
    "Add text to the end of an existing note without overwriting its current content. Creates the note if it doesn't exist yet.",
    {
      path: z.string().describe("Path to the note."),
      content: z.string().describe("Text to add. A blank line is inserted before it automatically."),
      commit_message: z.string().optional(),
    },
    async ({ path, content, commit_message }) => {
      try {
        let existing = "";
        try {
          existing = await readVaultFile(path);
        } catch {
          existing = "";
        }
        const merged = existing ? `${existing.replace(/\s+$/, "")}\n\n${content}\n` : `${content}\n`;
        const result = await writeVaultFile(path, merged, commit_message || `Append to ${path}`);
        return { content: [{ type: "text", text: `Note ${result === "created" ? "created" : "appended to"}: ${path}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error appending to '${path}': ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "rename_note",
    "Move or rename a note. Note: does not rewrite [[links]] in other notes that point to the old name — mention that to the user if relevant.",
    {
      old_path: z.string().describe("Current path of the note."),
      new_path: z.string().describe("New path for the note."),
      commit_message: z.string().optional(),
    },
    async ({ old_path, new_path, commit_message }) => {
      try {
        const content = await readVaultFile(old_path);
        await writeVaultFile(new_path, content, commit_message || `Rename ${old_path} to ${new_path}`);
        await deleteVaultFile(old_path, commit_message || `Rename ${old_path} to ${new_path}`);
        return { content: [{ type: "text", text: `Renamed '${old_path}' to '${new_path}'.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error renaming '${old_path}': ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_backlinks",
    "Find every note that links to a given note via [[wikilinks]].",
    { path: z.string().describe("Path of the note to find backlinks for.") },
    async ({ path }) => {
      try {
        const name = basenameNoExt(path);
        const files = await listVaultFiles();
        const pattern = new RegExp(`\\[\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\|[^\\]]*)?\\]\\]`, "i");
        const hits = [];
        for (const f of files) {
          if (f === path) continue;
          let content;
          try {
            content = await readVaultFile(f);
          } catch {
            continue;
          }
          if (pattern.test(content)) hits.push(f);
        }
        return { content: [{ type: "text", text: hits.length ? hits.join("\n") : `No backlinks found to '${path}'.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_folders",
    "List every folder path in the vault.",
    {},
    async () => {
      try {
        const files = await listVaultFiles();
        const folders = uniqueFolders(files);
        return { content: [{ type: "text", text: folders.length ? folders.join("\n") : "(no folders yet)" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_frontmatter",
    "Read just a note's YAML frontmatter (status, tags, project, etc.) without pulling the full body.",
    { path: z.string().describe("Path to the note.") },
    async ({ path }) => {
      try {
        const content = await readVaultFile(path);
        const { frontmatter } = parseFrontmatter(content);
        return { content: [{ type: "text", text: JSON.stringify(frontmatter, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error reading frontmatter for '${path}': ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "search_by_tag",
    "Find notes whose frontmatter `tags` field includes a given tag.",
    { tag: z.string().describe("Tag to search for (without '#'), case-insensitive.") },
    async ({ tag }) => {
      try {
        const files = await listVaultFiles();
        const q = tag.toLowerCase().replace(/^#/, "");
        const hits = [];
        for (const f of files) {
          let content;
          try {
            content = await readVaultFile(f);
          } catch {
            continue;
          }
          const { frontmatter } = parseFrontmatter(content);
          const tags = (frontmatter.tags || []).map((t) => String(t).toLowerCase());
          if (tags.includes(q)) hits.push(f);
        }
        return { content: [{ type: "text", text: hits.length ? hits.join("\n") : `No notes tagged '${tag}'.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_daily_note",
    "Get (or create, if create=true) the daily note for a given date. Defaults to today. Notes live at 'Daily/YYYY-MM-DD.md'.",
    {
      date: z.string().optional().describe("Date as YYYY-MM-DD. Defaults to today (server time)."),
      create: z.boolean().optional().describe("If true and the note doesn't exist, create it with a blank template."),
    },
    async ({ date, create }) => {
      const day = date || new Date().toISOString().slice(0, 10);
      const path = `Daily/${day}.md`;
      try {
        const content = await readVaultFile(path);
        return { content: [{ type: "text", text: content }] };
      } catch {
        if (!create) {
          return { content: [{ type: "text", text: `No daily note for ${day} yet. Call again with create=true to make one.` }] };
        }
        const template = `---\ndate: ${day}\n---\n\n`;
        await writeVaultFile(path, template, `Create daily note for ${day}`);
        return { content: [{ type: "text", text: `Created ${path}` }] };
      }
    }
  );

  server.tool(
    "graph_overview",
    "Get the knowledge graph's summary report — core topics/notes, surprising connections, and suggested questions. Good first call when asked something broad about the vault.",
    {},
    async () => {
      try {
        const report = await loadGraphReport();
        return { content: [{ type: "text", text: report }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `No graph report found yet (has the graphify workflow run? error: ${err.message})` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "graph_find_node",
    "Search the knowledge graph for nodes (notes/topics) whose label matches a query string.",
    { query: z.string().describe("Text to match against node labels (case-insensitive substring)") },
    async ({ query }) => {
      try {
        const graph = await loadGraph();
        const q = query.toLowerCase();
        const matches = Object.entries(graph.nodes || {})
          .filter(([id, node]) => (node.label || id).toLowerCase().includes(q))
          .slice(0, 25)
          .map(([id, node]) => `${id}: ${node.label || id}`);
        return { content: [{ type: "text", text: matches.length ? matches.join("\n") : "No matching nodes." }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "graph_neighbors",
    "Get everything directly connected to a graph node — what it links to and what links to it. Use graph_find_node first to get the node id.",
    { node_id: z.string().describe("Exact node id, as returned by graph_find_node") },
    async ({ node_id }) => {
      try {
        const graph = await loadGraph();
        const node = graph.nodes?.[node_id];
        if (!node) return { content: [{ type: "text", text: `No node with id '${node_id}'.` }], isError: true };

        const outgoing = (graph.links || []).filter((l) => l.source === node_id);
        const incoming = (graph.links || []).filter((l) => l.target === node_id);

        const lines = [`# ${node.label || node_id}`, ""];
        if (outgoing.length) {
          lines.push("Connects to:");
          outgoing.forEach((l) => lines.push(`- (${l.relation}) ${graph.nodes?.[l.target]?.label || l.target}`));
        }
        if (incoming.length) {
          lines.push("Connected from:");
          incoming.forEach((l) => lines.push(`- (${l.relation}) ${graph.nodes?.[l.source]?.label || l.source}`));
        }
        if (!outgoing.length && !incoming.length) lines.push("(no connections found)");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
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
