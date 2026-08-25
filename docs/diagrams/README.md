# Diagrams

## `kna-overview` — the short version

[`kna-overview.excalidraw`](kna-overview.excalidraw) — one page, 45 elements. The tools by name,
who talks to whom, and where the data goes. Start here; this is the one to put in a slide.

Who reads and who writes each store is written inside the store's own box rather than onto the
arrows. Eight labels sharing one corridor land on top of each other, and the same words sit
perfectly well next to the thing they describe.

## `kna-system` — the whole platform on one canvas

[`kna-system.excalidraw`](kna-system.excalidraw) opens in [Excalidraw](https://excalidraw.com)
(File > Open) or in the VS Code Excalidraw extension. [`kna-system.svg`](kna-system.svg) is the
same thing rendered, for reading without a tool.

Five zones, stacked:

| Zone | Shows |
|---|---|
| 1 | Every component and every link between them, with the protocol and credential on each |
| 2 | Ingest — the 19 steps from source code to a searchable index |
| 3 | Query — the retrieval pipeline, from question to cited answer |
| 4 | Documentation regeneration, and how it lands as a pull request |
| 5 | Tenancy, the pre-tenant probes, and the six guardrail layers |

Colour carries meaning: blue is a platform service, green a data store, amber a CI job, purple
something outside the platform, red a security boundary. A dashed border is optional or not yet
running. Red text is a failure the design exists to prevent, not a caption.

## Regenerating

The canvas is generated, not hand-drawn, so it can be kept honest as the system changes:

```bash
python scripts/gen-architecture-diagram.py
```

One run writes both canvases, and an `.svg` beside each.

Editing the `.excalidraw` by hand is fine — it is a normal Excalidraw file and dragging things
around is the point. Just know that re-running the generator overwrites it.

The generator lays every connection out in one of two empty corridors, one lane per arrow, and
asserts before writing that no arrow crosses a box, no two boxes overlap, no text overflows its
container, and no binding is dangling. Those checks are why the file is worth generating rather
than drawing.
