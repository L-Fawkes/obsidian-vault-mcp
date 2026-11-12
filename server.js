import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import yaml from "js-yaml";
import { registerAssetTools } from "./asset-tools.js";
import multer from "multer";
import { randomUUID, timingSafeEqual } from "node:crypto";

// ---- Config (set these as environment variables on Render) ----
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;       // fine-grained PAT, "Contents: Read-only" on the vault repo
const GITHUB_OWNER = process.env.GITHUB_OWNER;        // your GitHub username
const GITHUB_REPO = process.env.GITHUB_REPO;          // the vault repo name
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET; // optional: simple bearer token to keep randoms out

// Separate credentials and repository for RPG reference images.
const ASSETS_GITHUB_TOKEN = process.env.ASSETS_GITHUB_TOKEN;
const ASSETS_GITHUB_OWNER = process.env.ASSETS_GITHUB_OWNER;
const ASSETS_GITHUB_REPO = process.env.ASSETS_GITHUB_REPO;
const ASSETS_GITHUB_BRANCH = process.env.ASSETS_GITHUB_BRANCH || "main";
const ASSETS_UPLOAD_SECRET = process.env.ASSETS_UPLOAD_SECRET;
const EDITOR_ACCESS_SECRET = process.env.EDITOR_ACCESS_SECRET;
const ASSETS_ENABLED = Boolean(
  ASSETS_GITHUB_TOKEN && ASSETS_GITHUB_OWNER && ASSETS_GITHUB_REPO
);
const ASSETS_UPLOAD_ENABLED = Boolean(ASSETS_ENABLED && ASSETS_UPLOAD_SECRET);

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error("Missing required env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO");
  process.exit(1);
}

const GH_API = "https://api.github.com";
const assetHeaders = {
  Authorization: `Bearer ${ASSETS_GITHUB_TOKEN || ""}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "rpg-assets-bridge",
};

async function assetFetch(url) {
  const res = await fetch(url, { headers: assetHeaders });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Assets GitHub API ${res.status}: ${body.slice(0, 250)}`);
  }
  return res.json();
}

function assetRepoPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

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


  // RPG reference images: list files and return the actual image bytes to Claude.
  server.tool(
    "list_reference_images",
    "List image references uploaded from the user's phone to the private RPG-assets repository. Call this to find the latest visual references.",
    {
      limit: z.number().int().min(1).max(30).optional().describe("Maximum number of recent references (default 15)."),
    },
    async ({ limit }) => {
      try {
        if (!ASSETS_ENABLED) throw new Error("RPG asset connection is not configured on the server.");
        const tree = await assetFetch(`https://api.github.com/repos/${ASSETS_GITHUB_OWNER}/${ASSETS_GITHUB_REPO}/git/trees/${ASSETS_GITHUB_BRANCH}?recursive=1`);
        const files = (tree.tree || [])
          .filter((item) => item.type === "blob" && item.path.startsWith("references/inbox/") && /\\.(png|jpe?g|webp|gif)$/i.test(item.path))
          .sort((a, b) => b.path.localeCompare(a.path))
          .slice(0, limit || 15)
          .map((item) => item.path);
        return { content: [{ type: "text", text: files.length ? files.join("\\n") : "Nenhuma imagem encontrada em references/inbox/." }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro ao listar referências: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "read_reference_image",
    "Retrieve an uploaded RPG reference image as visual image content. Use the exact path returned by list_reference_images; this lets you inspect the image itself, not just its filename.",
    {
      path: z.string().describe("Exact image path returned by list_reference_images, under references/inbox/."),
    },
    async ({ path }) => {
      try {
        if (!ASSETS_ENABLED) throw new Error("RPG asset connection is not configured on the server.");
        if (!path.startsWith("references/inbox/") || path.includes("..") || path.startsWith("/")) {
          throw new Error("Invalid reference image path.");
        }
        if (!/\\.(png|jpe?g|webp|gif)$/i.test(path)) throw new Error("Unsupported image format.");
        const data = await assetFetch(`https://api.github.com/repos/${ASSETS_GITHUB_OWNER}/${ASSETS_GITHUB_REPO}/contents/${assetRepoPath(path)}?ref=${ASSETS_GITHUB_BRANCH}`);
        const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" })[path.split(".").pop().toLowerCase()];
        let encoded = data.content;
        if ((!encoded || data.encoding !== "base64") && data.sha) {
          const blob = await assetFetch(`https://api.github.com/repos/${ASSETS_GITHUB_OWNER}/${ASSETS_GITHUB_REPO}/git/blobs/${data.sha}`);
          encoded = blob.content;
          if (blob.encoding !== "base64") throw new Error("GitHub não retornou imagem em base64.");
        }
        const bytes = Buffer.from(encoded || "", "base64");
        if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error("Image is empty or exceeds the 12 MB visual retrieval limit.");
        return {
          content: [
            { type: "text", text: `Imagem de referência: ${path}` },
            { type: "image", data: bytes.toString("base64"), mimeType: mime },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro ao abrir imagem: ${err.message}` }], isError: true };
      }
    }
  );

  if (ASSETS_ENABLED) {
    server.tool(
      "read_editor_draft",
      "Read the latest PNG draft exported from the mobile RPG pixel editor. This is a working draft only, not an approved game asset.",
      {},
      async () => {
        try {
          const path = "editor-drafts/latest.png";
          const data = await assetFetch(`${GH_API}/repos/${ASSETS_GITHUB_OWNER}/${ASSETS_GITHUB_REPO}/contents/${assetRepoPath(path)}?ref=${ASSETS_GITHUB_BRANCH}`);
          let encoded = data.content;
          if ((!encoded || data.encoding !== "base64") && data.sha) {
            const blob = await assetFetch(`${GH_API}/repos/${ASSETS_GITHUB_OWNER}/${ASSETS_GITHUB_REPO}/git/blobs/${data.sha}`);
            encoded = blob.content;
          }
          const bytes = Buffer.from(encoded || "", "base64");
          if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error("Rascunho vazio ou acima de 12 MB.");
          return { content: [{ type: "text", text: "Rascunho atual do editor: editor-drafts/latest.png. Ainda não aprovado para uso no jogo." }, { type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Não foi possível ler o rascunho do editor: ${err.message}` }], isError: true };
        }
      }
    );
  }

  if (ASSETS_GITHUB_TOKEN && ASSETS_GITHUB_OWNER && ASSETS_GITHUB_REPO) {
    registerAssetTools(server, { z, token: ASSETS_GITHUB_TOKEN, owner: ASSETS_GITHUB_OWNER, repo: ASSETS_GITHUB_REPO, branch: ASSETS_GITHUB_BRANCH });
  }
  return server;
}

// ---- HTTP transport (stateless, one MCP server instance per request) ----
const app = express();
// Base64 expands binary images by roughly 4/3; allow a 12 MB source image plus JSON overhead.
app.use(express.json({ limit: "18mb" }));

app.use("/editor", express.static("public", { index: "editor.html", fallthrough: true }));

// The editor uses a dedicated credential; never expose GitHub or MCP credentials in the browser.
app.post("/editor/api/draft", async (req, res) => {
  if (!EDITOR_ACCESS_SECRET || !ASSETS_ENABLED) return res.status(503).json({ error: "Sincronização do editor não configurada." });
  if (!safeSecretEqual(req.headers.authorization?.replace(/^Bearer\s+/i, ""), EDITOR_ACCESS_SECRET)) {
    return res.status(401).json({ error: "Acesso não autorizado." });
  }
  try {
    const payload = req.body || {};
    const encoded = String(payload.image_base64 || "").replace(/^data:image\/png;base64,/i, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return res.status(400).json({ error: "PNG em base64 inválido." });
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) return res.status(413).json({ error: "PNG vazio ou acima de 12 MB." });
    const metadata = await (await import("sharp")).default(bytes, { limitInputPixels: 24000000 }).metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height || metadata.width * metadata.height > 24000000) {
      return res.status(400).json({ error: "O arquivo precisa ser um PNG válido de até 24 megapixels." });
    }
    const path = "editor-drafts/latest.png";
    const url = `${GH_API}/repos/${ASSETS_GITHUB_OWNER}/${ASSETS_GITHUB_REPO}/contents/${assetRepoPath(path)}`;
    const current = await fetch(`${url}?ref=${encodeURIComponent(ASSETS_GITHUB_BRANCH)}`, { headers: assetHeaders });
    let sha;
    if (current.ok) sha = (await current.json()).sha;
    else if (current.status !== 404) throw new Error(`GitHub ${current.status} ao consultar rascunho.`);
    const body = { message: "Update mobile RPG editor draft", content: bytes.toString("base64"), branch: ASSETS_GITHUB_BRANCH };
    if (sha) body.sha = sha;
    const saved = await fetch(url, { method: "PUT", headers: { ...assetHeaders, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!saved.ok) throw new Error(`GitHub ${saved.status}: ${(await saved.text()).slice(0, 180)}`);
    return res.json({ ok: true, path, width: metadata.width, height: metadata.height, format: metadata.format, channels: metadata.channels, bytes: bytes.length, status: "draft_not_approved" });
  } catch (err) {
    console.error("Editor draft sync failed:", err.message);
    return res.status(502).json({ error: "Não foi possível sincronizar o rascunho." });
  }
});

app.get("/editor/api/preview", async (req, res) => {
  if (!EDITOR_ACCESS_SECRET || !ASSETS_ENABLED) return res.status(503).json({ error: "Recepção de prévias não configurada." });
  if (!safeSecretEqual(req.headers.authorization?.replace(/^Bearer\\s+/i, ""), EDITOR_ACCESS_SECRET)) return res.status(401).json({ error: "Acesso não autorizado." });
  try {
    const base = `${GH_API}/repos/${ASSETS_GITHUB_OWNER}/${ASSETS_GITHUB_REPO}/contents/`;
    const metaRes = await fetch(base + assetRepoPath("editor-previews/latest.json") + "?ref=" + encodeURIComponent(ASSETS_GITHUB_BRANCH), { headers: assetHeaders });
    if (metaRes.status === 404) return res.status(404).json({ error: "Claude ainda não enviou nenhuma prévia." });
    if (!metaRes.ok) throw new Error("GitHub " + metaRes.status + " ao consultar metadados.");
    const metaFile = await metaRes.json();
    const metaBytes = metaFile.content && metaFile.encoding === "base64" ? Buffer.from(metaFile.content.replace(/\\s/g,""),"base64") : null;
    if (!metaBytes) throw new Error("Metadados da prévia indisponíveis.");
    const metadata = JSON.parse(metaBytes.toString("utf8"));
    if (!/^editor-previews\\/[0-9a-f-]{36}\\.png$/i.test(metadata.path || "")) throw new Error("Caminho de prévia inválido.");
    const imageRes = await fetch(base + assetRepoPath(metadata.path) + "?ref=" + encodeURIComponent(ASSETS_GITHUB_BRANCH), { headers: assetHeaders });
    if (!imageRes.ok) throw new Error("GitHub " + imageRes.status + " ao buscar PNG.");
    const imageFile = await imageRes.json();
    let encoded = imageFile.content;
    if ((!encoded || imageFile.encoding !== "base64") && imageFile.sha) {
      const blobRes = await fetch(`${GH_API}/repos/${ASSETS_GITHUB_OWNER}/${ASSETS_GITHUB_REPO}/git/blobs/${imageFile.sha}`, { headers: assetHeaders });
      if (!blobRes.ok) throw new Error("GitHub " + blobRes.status + " ao buscar blob.");
      const blob = await blobRes.json(); encoded = blob.content;
    }
    const bytes = Buffer.from(encoded || "", "base64");
    if (!bytes.length || bytes.length > 12*1024*1024) throw new Error("PNG vazio ou acima de 12 MB.");
    return res.json({ ...metadata, image_base64: bytes.toString("base64") });
  } catch (err) {
    console.error("Editor preview retrieval failed:",err.message);
    return res.status(502).json({ error: "Não foi possível receber a prévia do Claude." });
  }
});

app.get("/", (_req, res) => res.send("Obsidian vault MCP server is running."));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    const ext = file.originalname.toLowerCase().match(/\\.[^.]+$/)?.[0];
    if (!ext || allowed[ext] !== file.mimetype) return cb(new Error("Formato não permitido. Use PNG, JPG, WEBP ou GIF."));
    cb(null, true);
  },
});

function safeSecretEqual(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.get("/assets-upload", (_req, res) => {
  if (!ASSETS_UPLOAD_ENABLED) return res.status(503).send("Envio de imagens ainda não configurado no servidor.");
  res.type("html").send(`<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Enviar referência RPG</title><style>body{font:16px system-ui;background:#171923;color:#f4f1e9;margin:0;padding:24px}main{max-width:480px;margin:8vh auto;background:#252936;padding:24px;border-radius:16px}h1{font-size:22px}input,button{box-sizing:border-box;width:100%;padding:14px;margin:10px 0;border-radius:9px;border:1px solid #555;background:#171923;color:white}button{background:#73835b;border:0;font-weight:700}small{color:#bbb}</style><main><h1>Enviar imagem ao RPG Workshop</h1><p>Escolha uma imagem de referência. Ela ficará guardada no repositório privado para o Claude analisar.</p><form method="post" action="/assets-upload" enctype="multipart/form-data"><label>Senha de envio</label><input name="secret" type="password" autocomplete="current-password" required><label>Imagem (PNG, JPG, WEBP ou GIF)</label><input name="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required><small>Limite: 12 MB. A imagem original não será modificada.</small><button type="submit">Enviar imagem</button></form></main></html>`);
});

app.post("/assets-upload", (req, res) => {
  if (!ASSETS_UPLOAD_ENABLED) return res.status(503).send("Envio de imagens não configurado.");
  upload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).send(`Falha no envio: ${err.message}`);
    if (!safeSecretEqual(req.body?.secret, ASSETS_UPLOAD_SECRET)) return res.status(401).send("Senha incorreta. Volte e tente novamente.");
    if (!req.file) return res.status(400).send("Nenhuma imagem foi selecionada.");
    try {
      const original = req.file.originalname.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-90) || "referencia";
      const ext = original.toLowerCase().match(/\\.(png|jpe?g|webp|gif)$/)?.[0];
      if (!ext) return res.status(400).send("Extensão de imagem inválida.");
      const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${original}`;
      const path = `references/inbox/${filename}`;
      const url = `https://api.github.com/repos/${ASSETS_GITHUB_OWNER}/${ASSETS_GITHUB_REPO}/contents/${assetRepoPath(path)}`;
      const ghRes = await fetch(url, {
        method: "PUT",
        headers: { ...assetHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Add RPG reference image: ${filename}`,
          content: req.file.buffer.toString("base64"),
          branch: ASSETS_GITHUB_BRANCH,
        }),
      });
      if (!ghRes.ok) {
        const detail = await ghRes.text().catch(() => "");
        throw new Error(`GitHub respondeu ${ghRes.status}: ${detail.slice(0, 180)}`);
      }
      res.type("html").send(`<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><body style="font:16px system-ui;background:#171923;color:#f4f1e9;padding:24px"><h2>Imagem enviada!</h2><p>Arquivo: ${filename.replace(/[&<>"]/g, "")}</p><p>Agora abra o Claude e peça para listar as referências do RPG e analisar a imagem mais recente. O Claude poderá abrir a imagem pela conexão MCP.</p><p><a style="color:#b8ce91" href="/assets-upload">Enviar outra imagem</a></p></body></html>`);
    } catch (e) {
      console.error("Asset upload failed:", e.message);
      res.status(502).send("Não foi possível salvar a imagem no repositório. Tente novamente mais tarde.");
    }
  });
});



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
