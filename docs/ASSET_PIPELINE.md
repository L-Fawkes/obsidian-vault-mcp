# RPG Pixel Art — Asset Pipeline

Status (2026-11-12): deterministic pipeline foundation and TSX/TMX export orchestration are implemented and CI-tested on the feature branch. Artistic reconstruction, five-category proof, live MCP/Render workflow, and Tiled application round-trip remain unverified.

## Principles

1. Preserve every received reference byte-for-byte. A reference is never overwritten by a processed asset.
2. Separate reference material from game-ready production assets.
3. Treat AI as an analyst/planner and optional art assistant, not as a guarantee of pixel-perfect raster output.
4. Use deterministic code for dimensions, nearest-neighbor scaling, grid alignment, palette mapping, alpha checks, slicing, and file export.
5. Never publish a production asset without explicit user approval.
6. Keep all important parameters configurable. Do not assume a tile size or base resolution: use the current Visual Bible; if it does not define the value, record it as unknown and block dependent exports pending confirmation.

## Planned repository layout

- references/inbox/ — newly received source references
- references/originals/ — immutable originals retained with their source metadata
- production/sprites/ — approved standalone sprites
- production/tilesets/ — approved tileset PNGs and metadata
- production/maps/ — TMX maps and related files
- reports/ — validation and provenance reports
- `.staging/<UUID>/` — durable private staging with original.bin, prepared.png and metadata.json; removed during successful publication

## Pipeline stages

### A. Ingest and catalog
- Accept PNG, JPEG, WEBP, and GIF within configured byte/pixel limits.
- Validate actual file signature, not only extension or MIME label.
- Record original filename, SHA-256, format, dimensions, byte size, upload time, and reference ID.
- Preserve the original unchanged in references/originals/.
- Do not silently treat an upload as an approved production asset.

### B. Visual analysis and reconstruction plan
- Claude reads the project's visual bible and analyzes the reference.
- Return a structured plan: elements, material categories, suggested bounding boxes, layer order, scale, palette notes, and uncertainty.
- Human confirms/corrects the plan.
- The first implementation should not claim to infer perfect object masks automatically.

### C. Pixel-art preparation
- Keep a non-destructive source copy.
- Support crop, integer scaling, nearest-neighbor resampling, palette quantization/remapping, alpha handling, and grid guides.
- Provide a pixel-art-specific validation report.
- Do not claim that nearest-neighbor or color reduction repairs bad pixel art. Artistic cleanup must be manual or explicitly authored through a drawing/editing layer.

### D. Element slicing and classification
- Slice only from confirmed bounding boxes or a user-approved grid.
- Export each element independently with transparent padding rules.
- Keep stable IDs and a manifest mapping each tile to its source reference and coordinates.
- Automatic segmentation is a later capability and must be evaluated against manual masks before being trusted.

### E. Tileset assembly
- Pack sprites into a deterministic atlas with configurable tile dimensions, spacing, and margin.
- Preserve tile IDs and manifest metadata.
- Validate dimensions, duplicate IDs, alpha, bounds, and empty cells.
- Check visual adjacency only as a review aid; do not claim semantic seamlessness from geometry alone.

### F. Map and export
- Generate PNG atlas plus a Tiled TSX tileset definition.
- Generate TMX only when there is an actual tile placement grid and layer data; a tileset image alone is not a map.
- Validate all external asset paths and tile IDs.
- Open the exported result in Tiled for a real compatibility check.

### G. Preview, approval, save
- Show the actual processed image and report before saving.
- Require explicit approval tied to the exact asset/version ID.
- Save original, final output, manifest, and report as separate files.
- Never replace the original reference.

## First acceptance test

Use one already-pixel-art reference image:
1. Ingest and preserve the exact original; verify SHA-256 is unchanged.
2. Prepare a copy using nearest-neighbor only where scaling is required.
3. Validate image dimensions, alpha, configured grid divisibility, and palette count.
4. Preview the original and prepared output side by side.
5. Slice one user-confirmed rectangular element.
6. Pack a tiny test tileset and generate a TSX.
7. Generate a minimal TMX containing at least one layer and tile placement.
8. Open the result in Tiled and confirm it loads without missing assets.
9. Save only after explicit approval.

## Current implementation boundaries

Already present in the server repository:
- Sharp-based image ingestion and preparation with actual format detection, byte/pixel limits, EXIF orientation normalization, crop, nearest-neighbor resize, chroma-key and palette remapping.
- MCP tools prepare_asset, edit_asset_pixels, validate_asset, preview_asset, slice_asset_elements, build_asset_atlas, export_tiled_files and save_asset.
- GitHub-backed durable staging in `.staging/<UUID>/` with original, prepared PNG and SHA-256 metadata.
- SHA-256 integrity verification when staging is reloaded across stateless MCP requests.
- Atomic Git Data API commits for staging updates and final publication; final publication includes original, PNG, provenance report and staging deletions in one commit with non-forced branch update.
- Hash-bound explicit approval: the approved hash must match the exact current prepared PNG, and the confirmation phrase must match the asset ID and hash.

Current implementation status (2026-11-12):
- Staging expiration/cleanup is implemented as dry-run-first `cleanup_stale_asset_staging`; no real cleanup has been run.
- Atomic Git Data API persistence and bounded retry for recognized non-fast-forward conflicts are implemented. Recovery for arbitrary partial/network failures is not guaranteed; operations fail closed.
- The MCP export orchestration tools `slice_asset_elements`, `build_asset_atlas`, and `export_tiled_files` are implemented and covered by CI tests.
- Structured visual-analysis workflow is specified in `docs/VISUAL_FACTORY_MODULE_01.md`; the artistic analysis itself still requires model/human review and has not been validated end-to-end.
- Automated unit/contract tests and GitHub Actions CI are implemented for the current deterministic contracts. This does not replace real image review, Android/Render testing, or Tiled application round-trip.
- Cryptographic hashes (SHA-256) bind source/prepared files and approval. This is integrity/provenance metadata, not a digital signature or cryptographic identity attestation.

## Mobile editor draft synchronization

The mobile editor now has a dedicated authenticated endpoint: `POST /editor/api/draft`. Configure a separate high-entropy `EDITOR_ACCESS_SECRET` environment variable on Render; do not reuse `GITHUB_TOKEN`, `MCP_SHARED_SECRET`, or `ASSETS_GITHUB_TOKEN`. Enter this secret only in the editor's password field when syncing. It is held in the page memory and is not written to browser storage. The endpoint accepts a PNG data URL, enforces a 12 MB and 24 MP limit, and updates `editor-drafts/latest.png` in the private assets repository. It returns a draft status only; it does not approve or publish a production asset. Claude can inspect the current draft with the `read_editor_draft` MCP tool. Rotate the dedicated secret if it is exposed.

This sync is one-way from browser to shared draft. It does not yet stream live edits from Claude back into the open canvas. Real deployment and Android Chrome validation remain pending.

## Free toolchain

Required server-side runtime:
- Node.js 18 or newer.
- Existing npm dependencies, including Sharp.
- GitHub repository and the existing Render service.

Optional human review tools:
- Pixelorama for pixel-level drawing and cleanup.
- Tiled for assembling and validating TSX/TMX maps.

No paid image-generation API is required for deterministic image operations. The quality of artistic reconstruction must be reviewed; it cannot be guaranteed by resizing, palette mapping, or AI analysis alone.


## Atomic persistence and hash-bound approval

Staging writes and final publication use the Git Data API (blobs, one tree, one commit, then a non-forced branch ref update). A staging update writes the immutable original only on initial preparation; pixel edits update only the prepared PNG and metadata in the same commit.

Final publication creates the preserved original, approved PNG, and provenance report while removing the three staging files in one Git commit. If the branch reference cannot be advanced, the publication is not reported as complete and staging remains available.

Before calling `save_asset`, retrieve the current prepared SHA-256 from validation/preview metadata and obtain explicit user confirmation of the exact phrase:

`APROVO SALVAR <asset_id> <prepared_sha256>`

The tool also requires `approved_sha256` and checks it against the current staged PNG hash. Any intervening edit invalidates the approval and requires a new preview and confirmation.


## Deterministic export primitives (initial implementation)

The branch now includes `asset-export.js`:
- `sliceConfirmedBoxes`: crops only caller-confirmed integer rectangles, checks source bounds, unique stable IDs and a maximum of 512 elements; emits PNG crops and SHA-256 hashes.
- `packAtlas`: deterministic shelf packing in input order, transparent RGBA atlas, configurable padding/margin/maximum width and a JSON manifest with coordinates, dimensions and source hashes.
- `createTsx`: emits a Tiled XML tileset definition after validating tile geometry against the image dimensions.
- `createTmx`: emits an orthogonal finite map with a CSV layer only from explicit cell placements; duplicate cells, invalid GIDs and out-of-bounds coordinates are rejected.

These primitives have behavioral tests and are exposed through MCP orchestration tools that persist their outputs in staging. The atlas packer is intended for standalone sprites/atlas metadata, while TSX tile-grid export requires a regular tileset image. Do not treat an arbitrary packed sprite atlas as a uniform tile sheet. Tiled application round-trip testing remains a required acceptance step.


## MCP export orchestration (initial)

The MCP server now exposes:
- `slice_asset_elements`: takes user-confirmed rectangles and persists each crop plus a source-hash-bound manifest under the asset staging directory.
- `build_asset_atlas`: verifies the manifest is tied to the current prepared PNG, verifies each crop SHA-256, and persists the deterministic atlas PNG and manifest in staging.
- `export_tiled_files`: validates and writes TSX, plus an optional TMX only when explicit map dimensions and placements are supplied. Outputs remain in staging and are not production-published.

The TSX tool accepts a caller-supplied image source and dimensions; the caller must ensure the image actually exists at that path in the eventual project. A packed irregular sprite atlas is not automatically suitable as a regular grid TSX tileset. No TMX placements are inferred. The user must review the generated files in Tiled before any production save.


## Staging lifecycle cleanup

The MCP tool `cleanup_stale_asset_staging` lists stale candidates by default without deleting anything. Its default TTL is 30 days (configurable from 7 to 365 days). Deletion requires an explicit `dry_run: false` call. Only staging directories with valid UUID metadata, a matching metadata path and a parseable `createdAt` older than the TTL are eligible. If GitHub reports a truncated recursive tree, cleanup aborts rather than guessing. It deletes only files below the matching `.staging/<asset-id>/` directory and commits the deletions together. Production asset folders are outside its scope.


## Concurrent staging writes

Multi-file commits are rebuilt from the latest branch head when GitHub explicitly rejects a non-fast-forward ref update (HTTP 422 with a recognized concurrency message). The helper retries at most three total attempts, never force-pushes, and fails closed for permission, validation, network, or unrecognized errors. A retry recreates the tree and commit on the newest parent; any unreachable intermediate Git objects are harmless and are not referenced by the branch.
