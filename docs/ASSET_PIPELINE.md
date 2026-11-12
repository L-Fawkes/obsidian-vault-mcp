# RPG Pixel Art — Asset Pipeline

Status: foundation in progress. This document describes the first testable scope; it does not claim that automatic artistic reconstruction or TMX export already exists.

## Principles

1. Preserve every received reference byte-for-byte. A reference is never overwritten by a processed asset.
2. Separate reference material from game-ready production assets.
3. Treat AI as an analyst/planner and optional art assistant, not as a guarantee of pixel-perfect raster output.
4. Use deterministic code for dimensions, nearest-neighbor scaling, grid alignment, palette mapping, alpha checks, slicing, and file export.
5. Never publish a production asset without explicit user approval.
6. Keep all important parameters configurable. A 48x48 px tile is the provisional starting unit, not a hard-coded global truth.

## Planned repository layout

- references/inbox/ — newly received source references
- references/originals/ — immutable originals retained with their source metadata
- production/sprites/ — approved standalone sprites
- production/tilesets/ — approved tileset PNGs and metadata
- production/maps/ — TMX maps and related files
- reports/ — validation and provenance reports
- staging/ — temporary generated previews only if persistence is deliberately implemented

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
- Sharp-based image ingestion and preparation.
- prepare_asset, validate_asset, preview_asset, and save_asset MCP tools.
- Reference listing and image retrieval tools.
- GitHub-backed storage for originals, prepared PNGs, and reports.

Not yet implemented:
- durable staging across server restarts;
- cryptographic provenance metadata in the asset report;
- structured analysis manifest and approved bounding-box slicing;
- deterministic atlas packing and tile manifest;
- TSX/TMX generation and round-trip validation;
- automated tests and CI coverage for image edge cases.

## Free toolchain

Required server-side runtime:
- Node.js 18 or newer.
- Existing npm dependencies, including Sharp.
- GitHub repository and the existing Render service.

Optional human review tools:
- Pixelorama for pixel-level drawing and cleanup.
- Tiled for assembling and validating TSX/TMX maps.

No paid image-generation API is required for deterministic image operations. The quality of artistic reconstruction must be reviewed; it cannot be guaranteed by resizing, palette mapping, or AI analysis alone.
