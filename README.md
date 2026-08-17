# Obsidian Vault MCP (free, no card, no always-on computer needed)

This gives Claude (mobile, desktop, web) read access to your Obsidian vault
through a small server hosted for free on Render, reading straight from a
GitHub repo. Your vault syncs to GitHub from your phone and desktop via the
Obsidian Git plugin — nothing needs to stay powered on.

## Pieces
- **GitHub repo** — the vault's source of truth (free, private).
- **Obsidian Git plugin** — auto-commits/pushes/pulls from desktop + phone.
- **This MCP server** — reads the repo via GitHub's API, exposes `list_notes`,
  `read_note`, `search_notes` over MCP. Deployed free on Render.
- **Graphify** — optional, run locally, commit its output into the repo like
  any other notes.

## 1. Create the GitHub repo
1. github.com → New repository → name it e.g. `obsidian-vault` → **Private** → Create.
2. Settings → Developer settings → Personal access tokens → **Fine-grained token**:
   - Repository access: only this repo.
   - Permissions: **Contents → Read and write** (needed so Claude can create
     and edit notes, not just read them).
   - Copy the token — you'll paste it into Render as `GITHUB_TOKEN`.

## 2. Wire up Obsidian Git (desktop + phone)
1. Obsidian → Settings → Community plugins → browse → install **Obsidian Git**.
2. Point your vault folder at a local clone of the repo (or `git init` it in
   place and add the GitHub repo as `origin`).
3. In the plugin settings, turn on **auto backup on interval** (e.g. every
   10 min) and **auto pull on load** — it'll commit + push + pull for you.
4. On phone: install Obsidian mobile, add the same plugin (it works on
   iOS/Android), sign in to GitHub in the plugin's auth screen.

Now every device pushes/pulls to the same repo — that repo is your sync layer.

## 3. Deploy the MCP server to Render (free)
1. Push this folder (`server.js`, `package.json`, `render.yaml`) to its own
   **public or private GitHub repo** (separate from the vault repo).
2. render.com → New → Web Service → connect that repo.
3. It should auto-detect `render.yaml`. If not: Build command `npm install`,
   Start command `npm start`, plan **Free**.
4. Add environment variables:
   - `GITHUB_TOKEN` — the fine-grained token from step 1
   - `GITHUB_OWNER` — your GitHub username
   - `GITHUB_REPO` — your vault repo name (e.g. `obsidian-vault`)
   - `GITHUB_BRANCH` — `main` (or whatever your default branch is)
   - `MCP_SHARED_SECRET` — make up a random string; this keeps randoms who
     find your Render URL from reading your vault
5. Deploy. You'll get a URL like `https://obsidian-vault-mcp.onrender.com`.

Free tier note: it sleeps after ~15 min idle and takes a few seconds to wake
on the next request — fine for occasional Claude queries.

## 4. Connect it to Claude
In Claude → Settings → Connectors → Add custom connector:
- URL: `https://<your-app>.onrender.com/mcp`
- Header: `Authorization: Bearer <your MCP_SHARED_SECRET>`

Then just ask Claude to search, read, or edit your notes — it'll call
`search_notes` / `read_note` / `list_notes` / `write_note` / `delete_note`
automatically. Writes commit straight to the repo, so they'll show up on
your phone/desktop next time Obsidian Git syncs (or immediately if you have
auto-pull-on-interval turned on).

**Heads up on writes:** `write_note` overwrites the whole file — for edits
to an existing note, have Claude read it first, then write back the full
updated content. `delete_note` is a real, permanent git commit; it's worth
asking Claude to confirm with you before deleting anything.

## 5. (Optional) Graphify
Run locally whenever you want:
```
pip install graphifyy --break-system-packages
graphify install
graphify ./YourVaultFolder --obsidian
```
Commit the generated notes into the vault repo like anything else — next
sync, they show up everywhere, including to Claude.

## Local test (optional, before deploying)
```
npm install
GITHUB_TOKEN=xxx GITHUB_OWNER=you GITHUB_REPO=obsidian-vault npm start
```
Then POST to `http://localhost:3000/mcp` with an MCP client, or just deploy
straight to Render and test through Claude.
