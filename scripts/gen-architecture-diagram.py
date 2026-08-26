# Generates docs/diagrams/kna-system.excalidraw
import json, random, uuid

random.seed(7)
E = []

def rid(): return uuid.uuid4().hex[:20]
def sd(): return random.randint(1, 2**31 - 1)

def base(**kw):
    d = dict(id=rid(), angle=0, strokeColor="#1e1e1e", backgroundColor="transparent",
             fillStyle="solid", strokeWidth=2, strokeStyle="solid", roughness=1, opacity=100,
             groupIds=[], frameId=None, roundness=None, seed=sd(), version=1,
             versionNonce=sd(), isDeleted=False, boundElements=[], updated=1,
             link=None, locked=False)
    d.update(kw)
    return d

def text_el(x, y, w, h, s, size=16, colour="#1e1e1e", align="center", family=5, container=None):
    lines = s.count("\n") + 1
    t = base(type="text", x=x, y=y, width=w, height=h, strokeColor=colour,
             fontSize=size, fontFamily=family, text=s, originalText=s,
             textAlign=align, verticalAlign="middle", containerId=container,
             lineHeight=1.25, autoResize=container is None,
             baseline=int(size * 0.8))
    E.append(t)
    return t

def box(x, y, w, h, s, stroke="#1e1e1e", bg="transparent", size=16, dashed=False,
        family=5, fill="solid", radius=True):
    r = base(type="rectangle", x=x, y=y, width=w, height=h, strokeColor=stroke,
             backgroundColor=bg, fillStyle=fill,
             strokeStyle="dashed" if dashed else "solid",
             roundness={"type": 3} if radius else None)
    E.append(r)
    lines = s.count("\n") + 1
    th = lines * size * 1.25
    t = text_el(x + 8, y + (h - th) / 2, w - 16, th, s, size=size, family=family,
                container=r["id"])
    r["boundElements"] = [{"type": "text", "id": t["id"]}]
    r["_c"] = (x + w / 2, y + h / 2)
    return r

def anchor(b, side):
    x, y, w, h = b["x"], b["y"], b["width"], b["height"]
    return {"l": (x, y + h / 2), "r": (x + w, y + h / 2),
            "t": (x + w / 2, y), "b": (x + w / 2, y + h)}[side]

def arrow(a, b, label=None, sides=None, colour="#1e1e1e", dashed=False, via=None, size=13):
    if sides is None:
        ax, ay = a["_c"]; bx, by = b["_c"]
        if abs(bx - ax) >= abs(by - ay):
            sides = ("r", "l") if bx > ax else ("l", "r")
        else:
            sides = ("b", "t") if by > ay else ("t", "b")
    sx, sy = anchor(a, sides[0])
    ex, ey = anchor(b, sides[1])
    pts = [[0, 0]]
    for (vx, vy) in (via or []):
        pts.append([vx - sx, vy - sy])
    pts.append([ex - sx, ey - sy])
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    ar = base(type="arrow", x=sx, y=sy, width=max(xs) - min(xs), height=max(ys) - min(ys),
              strokeColor=colour, strokeStyle="dashed" if dashed else "solid",
              roundness={"type": 2}, points=pts,
              startBinding={"elementId": a["id"], "focus": 0, "gap": 6},
              endBinding={"elementId": b["id"], "focus": 0, "gap": 6},
              startArrowhead=None, endArrowhead="arrow", elbowed=False)
    E.append(ar)
    a["boundElements"].append({"type": "arrow", "id": ar["id"]})
    b["boundElements"].append({"type": "arrow", "id": ar["id"]})
    if label:
        lines = label.count("\n") + 1
        t = text_el(sx, sy, 10 * len(label), lines * size * 1.25, label, size=size,
                    colour=colour, family=5, container=ar["id"])
        ar["boundElements"] = [{"type": "text", "id": t["id"]}]
    return ar

def heading(x, y, s, size=28):
    text_el(x, y, 900, size * 1.3, s, size=size, align="left", family=5)

def zone(x, y, w, h, title):
    r = base(type="rectangle", x=x, y=y, width=w, height=h, strokeColor="#adb5bd",
             backgroundColor="transparent", strokeStyle="dashed", strokeWidth=1,
             roundness={"type": 3})
    E.append(r)
    heading(x + 24, y + 18, title)
    return r

SVC = ("#1971c2", "#a5d8ff")
DAT = ("#2f9e44", "#b2f2bb")
CI  = ("#f08c00", "#ffec99")
EXT = ("#9c36b5", "#eebefa")
SEC = ("#e03131", "#ffc9c9")
STEP = ("#1e1e1e", "#f8f9fa")

# ══════════════════════════════════════════════════════════════════════════════
# ZONE 1 — Components and how they communicate
# ══════════════════════════════════════════════════════════════════════════════
def emit(stem):
    """Validate the canvas, then write it as both an .excalidraw and an .svg."""
    # --- checks ------------------------------------------------------------------
    # These are the reason this file is generated rather than drawn. A hand-drawn canvas
    # drifts silently; a generated one refuses to be written when it stops being legible.
    by_id = {e["id"]: e for e in E}
    assert len(by_id) == len(E), "duplicate element ids"

    for e in E:
        if e["type"] == "arrow":
            for k in ("startBinding", "endBinding"):
                assert not e[k] or e[k]["elementId"] in by_id, "dangling arrow binding"
        if e["type"] == "text" and e.get("containerId"):
            assert e["containerId"] in by_id, "dangling text container"

    def label_of(r):
        return next((by_id[b["id"]]["text"] for b in r["boundElements"] if b["type"] == "text"), "")

    # Zone backdrops and the CI grouping box are containers, not content: things are
    # meant to sit inside them and arrows are meant to cross their edges.
    solid = [e for e in E if e["type"] == "rectangle"
             and e["strokeColor"] != "#adb5bd" and label_of(e).strip()]

    def overlaps(a, b):
        return not (a["x"] + a["width"] <= b["x"] or b["x"] + b["width"] <= a["x"] or
                    a["y"] + a["height"] <= b["y"] or b["y"] + b["height"] <= a["y"])

    for i, a in enumerate(solid):
        for b in solid[i + 1:]:
            assert not overlaps(a, b), "boxes overlap: %s / %s" % (
                label_of(a).splitlines()[0], label_of(b).splitlines()[0])

    def crosses(p, q, r):
        x0, y0 = r["x"] + 3, r["y"] + 3
        x1, y1 = r["x"] + r["width"] - 3, r["y"] + r["height"] - 3
        if p[0] == q[0]:
            return x0 < p[0] < x1 and max(y0, min(p[1], q[1])) < min(y1, max(p[1], q[1]))
        if p[1] == q[1]:
            return y0 < p[1] < y1 and max(x0, min(p[0], q[0])) < min(x1, max(p[0], q[0]))
        return False

    for e in E:
        if e["type"] != "arrow":
            continue
        pts = [(e["x"] + p[0], e["y"] + p[1]) for p in e["points"]]
        ends = {e["startBinding"]["elementId"], e["endBinding"]["elementId"]}
        for a, b in zip(pts, pts[1:]):
            for r in solid:
                if r["id"] in ends:
                    continue
                assert not crosses(a, b, r), "arrow crosses %s" % label_of(r).splitlines()[0]

    for e in E:
        if e["type"] != "text" or not e.get("containerId"):
            continue
        c = by_id[e["containerId"]]
        if c["type"] != "rectangle":
            continue
        lines = e["text"].split("\n")
        wide = max(len(l) for l in lines) * e["fontSize"] * 0.58
        tall = len(lines) * e["fontSize"] * 1.25
        assert wide <= c["width"] - 12 and tall <= c["height"] - 8, \
            "text overflows its box: %s" % lines[0][:40]

    # --- write -------------------------------------------------------------------
    import os
    os.makedirs("docs/diagrams", exist_ok=True)
    for e in E:
        e.pop("_c", None)

    with open("docs/diagrams/%s.excalidraw" % stem, "w", encoding="utf-8") as f:
        json.dump({"type": "excalidraw", "version": 2, "source": "kna", "elements": E,
                   "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"},
                   "files": {}}, f, indent=2, ensure_ascii=False)

    # An SVG alongside it, so the diagram is readable on GitHub and in a browser without
    # opening Excalidraw. Deliberately plain: this is a rendering, not the source.
    import html as _html
    xs = [e["x"] for e in E]; ys = [e["y"] for e in E]
    xe = [e["x"] + e["width"] for e in E]; ye = [e["y"] + e["height"] for e in E]
    mnx, mny = min(xs) - 40, min(ys) - 40
    w, h = max(xe) + 40 - mnx, max(ye) + 40 - mny
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="%g %g %g %g" width="%g" '
           'height="%g" style="background:#fff">' % (mnx, mny, w, h, w, h),
           '<defs><marker id="a" markerWidth="9" markerHeight="9" refX="8" refY="3" '
           'orient="auto"><path d="M0,0 L8,3 L0,6" fill="none" stroke="#555" '
           'stroke-width="1.4"/></marker></defs>']
    for e in E:
        dash = ' stroke-dasharray="8 6"' if e["strokeStyle"] == "dashed" else ""
        if e["type"] == "rectangle":
            fill = "none" if e["backgroundColor"] == "transparent" else e["backgroundColor"]
            svg.append('<rect x="%g" y="%g" width="%g" height="%g" rx="8" fill="%s" '
                       'stroke="%s" stroke-width="%g"%s/>'
                       % (e["x"], e["y"], e["width"], e["height"], fill,
                          e["strokeColor"], e["strokeWidth"], dash))
        elif e["type"] == "arrow":
            pts = " ".join("%g,%g" % (e["x"] + p[0], e["y"] + p[1]) for p in e["points"])
            svg.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.8" '
                       'marker-end="url(#a)"%s/>' % (pts, e["strokeColor"], dash))
    for e in E:
        if e["type"] != "text":
            continue
        lines = e["text"].split("\n"); fs = e["fontSize"]; lh = fs * 1.25
        cid = e.get("containerId")
        if cid and by_id[cid]["type"] == "rectangle":
            c = by_id[cid]
            cx = c["x"] + c["width"] / 2
            y0 = c["y"] + (c["height"] - len(lines) * lh) / 2 + fs
            anchor_ = "middle"
        elif cid:
            c = by_id[cid]
            px = [c["x"] + p[0] for p in c["points"]]
            py = [c["y"] + p[1] for p in c["points"]]
            cx, anchor_ = sum(px) / len(px), "middle"
            y0 = sum(py) / len(py) - len(lines) * lh / 2 + fs
            lw = max(len(l) for l in lines) * fs * 0.58
            svg.append('<rect x="%g" y="%g" width="%g" height="%g" fill="#fff" opacity="0.9"/>'
                       % (cx - lw / 2, y0 - fs, lw, len(lines) * lh))
        else:
            cx, y0, anchor_ = e["x"], e["y"] + fs, "start"
        for i, ln in enumerate(lines):
            svg.append('<text x="%g" y="%g" font-family="Segoe UI,sans-serif" font-size="%g" '
                       'fill="%s" text-anchor="%s" xml:space="preserve">%s</text>'
                       % (cx, y0 + i * lh, fs, e["strokeColor"], anchor_, _html.escape(ln)))
    svg.append("</svg>")
    with open("docs/diagrams/%s.svg" % stem, "w", encoding="utf-8") as f:
        f.write("\n".join(svg))

    kinds = {}
    for e in E:
        kinds[e["type"]] = kinds.get(e["type"], 0) + 1
    print("ok  %-14s %3d elements  %dx%d" % (stem, len(E), w, h))

# ==============================================================================
# The detailed canvas
# ==============================================================================
zone(0, 0, 2360, 1340, "1 · Components, and how they talk to each other")

dev    = box(70, 130, 230, 60, "Developer", *EXT)
editor = box(70, 230, 230, 80, "Editor\nClaude Code / Cursor", *EXT, size=14)
cli    = box(70, 350, 230, 80, "kna CLI\ninit describe scan\ngenerate publish ask", *EXT, size=13)
repo   = box(70, 480, 230, 70, "Git repository\n+ kna.config.yaml", "#1e1e1e", "#ffffff", size=13)

ciz = box(50, 600, 270, 350, "", "#f08c00", "transparent", dashed=True)
text_el(66, 612, 238, 22, "GitHub Actions", size=15, colour="#f08c00", family=5)
an  = box(70, 648, 230, 88, "analyse job\nno credentials\nRUNS repo build logic", *CI, size=12)
pub = box(70, 762, 230, 88, "publish job\nHOLDS credential\nruns no repo code", *CI, size=12)
prj = box(70, 872, 230, 62, "docs PR job\ncontents: write", *CI, size=12)

hook = box(70, 1000, 230, 70, "Git provider\npush / PR webhooks", *EXT, size=13)

api = box(790, 150, 400, 250,
          "API   :8080\n\n/v1/ingest      trust boundary\n/v1/search      hybrid retrieval\n"
          "/v1/docs        published prose\n/v1/webhooks/git\n/v1/auth/ci-exchange\n"
          "/v1/admin/*     repos principals\n                reindex erasure\n"
          "/admin          console\n/health/live  /health/ready", *SVC, size=12)

mcp = box(790, 450, 400, 180,
          "MCP server   :8081\nstreamable HTTP, RFC 9728\n\n"
          "search_codebase   get_symbol\nfind_usages       search_docs\n"
          "get_architecture  get_api_spec\nget_changes_since\n\nread-only, permanently", *SVC, size=12)

wrk = box(790, 690, 400, 210,
          "Worker\nBullMQ consumers\n\nindex-module\nregenerate-docs\n"
          "cross-repo-resolution\nmaintenance\n\nadvisory lock per module", *SVC, size=12)

pg = box(1580, 150, 330, 230,
         "PostgreSQL\n\nRow-Level Security, FORCED\npgvector  halfvec 1536  HNSW\n\n"
         "roles:\n  kna_interactive  SELECT\n  kna_batch        write\n  owner            migrate", *DAT, size=12)

redis = box(1580, 430, 330, 110, "Redis\nBullMQ queues\njob id = (module, sha)", *DAT, size=13)

obj = box(1580, 590, 330, 130,
          "Object storage\nS3 / MinIO\n\nIR bundles\nTHE SYSTEM OF RECORD", *DAT, size=13)

lite = box(1580, 770, 330, 120,
           "LiteLLM proxy   :4000\nroutes, not model ids:\nchat  query  blurb  docgen", *EXT, size=13)

prov = box(1580, 940, 330, 70, "Model provider\nOpenAI / Bedrock / Azure", *EXT, size=13)
rer  = box(1580, 1050, 330, 96,
           "Reranker  (optional)" + chr(10) + "cross-encoder, called by /v1/search" + chr(10) +
           "when configured. Not running locally," + chr(10) + "which is why answers say so.",
           "#9c36b5", "transparent", size=12, dashed=True)

# --- arrows -------------------------------------------------------------------
# Two empty corridors carry every connection: A between the left column and the
# services (x 320-780), B between the services and the stores (x 1200-1570). Each
# arrow gets its own lane inside one of them, so no line ever crosses a box.
def cy(b): return b["y"] + b["height"] / 2

def lane_rl(a, b, x):          # a's right edge -> lane -> b's left edge
    return dict(sides=("r", "l"), via=[(x, cy(a)), (x, cy(b))])

def lane_rr(a, b, x):          # right edge -> lane -> back to the right edge
    return dict(sides=("r", "r"), via=[(x, cy(a)), (x, cy(b))])

arrow(dev, editor)
arrow(dev, cli, **lane_rr(dev, cli, 330))
arrow(repo, an, label="push / PR")
arrow(an, pub, label="kna-ir.json artifact")
arrow(an, prj, label="docs artifact", **lane_rr(an, prj, 360))
arrow(prj, repo, label="opens PR", **lane_rr(prj, repo, 415))

arrow(editor, mcp, label="MCP over HTTP" + chr(10) + "Bearer KNA_MCP_TOKEN", **lane_rl(editor, mcp, 520))
arrow(cli, api, label="HTTPS  KNA_TOKEN", **lane_rl(cli, api, 600))
arrow(pub, api, label="POST /v1/ingest" + chr(10) + "signed envelope", colour="#e03131", **lane_rl(pub, api, 690))
arrow(hook, api, label="HMAC-signed webhook", **lane_rl(hook, api, 755))

arrow(api, pg, label="withOrgContext", **lane_rl(api, pg, 1230))
arrow(api, redis, label="enqueue", **lane_rl(api, redis, 1270))
arrow(api, obj, label="put bundle", **lane_rl(api, obj, 1310))
arrow(api, lite, label="embed query", **lane_rl(api, lite, 1350))
arrow(mcp, pg, label="ACL in SQL", **lane_rl(mcp, pg, 1390))
arrow(wrk, pg, label="partition swap" + chr(10) + "+ stale sweep", **lane_rl(wrk, pg, 1430))
arrow(wrk, redis, label="consume", **lane_rl(wrk, redis, 1470))
arrow(wrk, obj, label="get bundle", **lane_rl(wrk, obj, 1505))
arrow(wrk, lite, label="embed  blurb  docgen", **lane_rl(wrk, lite, 1545))
arrow(lite, prov)

text_el(340, 1180, 1180, 120,
        "The analyse / publish split is the trust boundary. The analyse job runs the repository's own build logic and holds no credential;\n"
        "the publish job holds the credential and runs none of the repository's code. Collapsing them puts a publish credential on a runner\n"
        "executing repository-controlled code, which is remote code execution by design.",
        size=13, colour="#e03131", align="left")

# ══════════════════════════════════════════════════════════════════════════════
# ZONE 2 — Ingest: source code to searchable index
# ══════════════════════════════════════════════════════════════════════════════
Y = 1440
zone(0, Y, 2360, 800, "2 · Ingest — from source code to a searchable index")

def chain(items, x0, y0, w, h, gap, colour, label_size=12, vertical=False):
    made = []
    for i, s in enumerate(items):
        x = x0 if vertical else x0 + i * (w + gap)
        y = y0 + i * (h + gap) if vertical else y0
        made.append(box(x, y, w, h, s, *colour, size=label_size))
    for a, b in zip(made, made[1:]):
        arrow(a, b)
    return made

text_el(40, Y + 78, 400, 24, "In the repository  ·  no platform involved", size=15,
        colour="#9c36b5", align="left")
a1 = chain([
    "1  discover\nmodules from\nmanifests",
    "2  analyse\nTier 0 lexical\nTier 1 semantic\nTier 2 config",
    "3  assemble IR\nstable ids, drop\nduplicate symbols",
    "4  guardrail scan\nFAIL CLOSED\non a finding",
    "5  classify\nsensitivity tier\nper chunk",
    "6  sign envelope\nHMAC or Sigstore\norg + repo + sha",
], 40, Y + 112, 250, 108, 42, EXT, 12)

text_el(40, Y + 268, 400, 24, "Crossing the trust boundary", size=15, colour="#e03131", align="left")
b1 = box(40, Y + 300, 250, 108,
         "7  POST /v1/ingest\nverify signature\norg matches envelope\nrepo in credential scope", *SEC, size=12)
b2 = box(332, Y + 300, 250, 108,
         "8  store bundle\nobject storage\nsystem of record\nPostgres is a cache", *DAT, size=12)
b3 = box(624, Y + 300, 250, 108,
         "9  diff against\nstored IR\nunchanged modules\ncost nothing", *SVC, size=12)
b4 = box(916, Y + 300, 250, 108,
         "10  circuit breaker\nmagnitude check\nBEFORE fan-out,\nnot during it", *SEC, size=12)
b5 = box(1208, Y + 300, 250, 108,
         "11  enqueue\none index-module\njob per changed\nmodule", *SVC, size=12)
arrow(a1[-1], b1, sides=("b", "t"), via=[(1665, Y + 250), (165, Y + 250)])
for p, q in zip([b1, b2, b3, b4], [b2, b3, b4, b5]):
    arrow(p, q)

text_el(40, Y + 448, 500, 24, "In the worker  ·  one module at a time", size=15,
        colour="#1971c2", align="left")
c1 = chain([
    "12  advisory lock\non the module\nPostgres, not\nBullMQ",
    "13  chunk\nsplit to the\nembedding\ntoken budget",
    "14  embed\nvia LiteLLM\ncontent-hash\ncache",
    "15  partition swap\nwrite the new\nrows atomically",
    "16  sweep\ndelete chunks and\nsymbols this run\ndid not write",
    "17  resolve\nproject slugs\nto prj_ ids",
], 40, Y + 482, 250, 108, 42, SVC, 12)
arrow(b5, c1[0], sides=("b", "t"), via=[(1333, Y + 440), (165, Y + 440)])

d1 = box(1792, Y + 482, 250, 108, "18  cross-repo\nedge resolution\nAPI contracts,\npackage deps", *SVC, size=12)
d2 = box(1792, Y + 300, 250, 108, "19  enqueue\nregenerate-docs\ndebounced 60s\nper (repo, ref)", *SVC, size=12)
arrow(c1[-1], d1)
arrow(d1, d2)

text_el(40, Y + 640, 2000, 100,
        "The sweep compares chunk and symbol ids against what this run just wrote — never commit shas. Comparing shas is right for a new commit and\n"
        "silently wrong for the two cases that reindex the same one: a deliberate /v1/admin/reindex, and a crashed run retried. Stale rows carried the\n"
        "matching sha, survived, and the corpus held two versions of the same code at once.",
        size=13, colour="#e03131", align="left")

# ══════════════════════════════════════════════════════════════════════════════
# ZONE 3 — Query: a question to a cited answer
# ══════════════════════════════════════════════════════════════════════════════
Y = 2340
zone(0, Y, 2360, 660, "3 · Query — from a question to an answer that cites its evidence")

q  = box(40, Y + 120, 220, 80, "Question\nfrom editor or CLI", *EXT, size=13)
un = box(320, Y + 120, 240, 80, "understand\nrewrite multi-turn,\nclassify intent", *SVC, size=12)
arrow(q, un)

acl = box(620, Y + 96, 260, 128,
          "ACL PREDICATE\nbuilt from the caller's\nidentity, applied IN SQL\nBEFORE scoring", *SEC, size=12)
arrow(un, acl)

arm1 = box(940, Y + 60, 260, 74, "dense\npgvector HNSW  k=50", *DAT, size=12)
arm2 = box(940, Y + 152, 260, 74, "lexical\nBM25 tsvector  k=50", *DAT, size=12)
arm3 = box(940, Y + 244, 260, 74, "symbol exact\ndirect IR lookup  k=10", *DAT, size=12)
for a in (arm1, arm2, arm3):
    arrow(acl, a)

fus = box(1268, Y + 152, 230, 74, "Reciprocal\nRank Fusion", *SVC, size=13)
for a in (arm1, arm2, arm3):
    arrow(a, fus)

div = box(1560, Y + 152, 230, 74, "diversity\nMMR + per-module cap", *SVC, size=12)
rrk = box(1852, Y + 152, 230, 74, "rerank\ncross-encoder\ntop 50 to top 8", *SVC, size=12)
arrow(fus, div); arrow(div, rrk)

exp = box(1852, Y + 320, 230, 92, "graph expansion\ncallers, callees,\ntype definitions\nwithin token budget", *SVC, size=12)
arrow(rrk, exp)

abs_ = box(1500, Y + 320, 290, 92,
           "ABSTENTION GATE\nscore < 0.35, or too few\ncandidates with no reranker\n->  refuse, no model call", *SEC, size=12)
arrow(exp, abs_)

ans = box(1120, Y + 320, 300, 92,
          "answer synthesis\nevery claim cites evidence\nhedging forced when shallow\nor the repo is stale", *SVC, size=12)
arrow(abs_, ans)

out = box(760, Y + 320, 280, 92, "Answer\nnumbered citations,\nfile and line for each", *EXT, size=13)
arrow(ans, out)

tr = box(360, Y + 320, 300, 92, "query_traces\nevery stage timing,\nabstained, top score\nreplayable", *DAT, size=12)
arrow(ans, tr, dashed=True, label="every query traced", sides=("b", "b"), via=[(1270, Y + 448), (510, Y + 448)])

text_el(40, Y + 470, 2200, 130,
        "The ACL filter is a hard predicate in the database query, not a prompt instruction and not a post-filter. Filtering after ranking still leaks result\n"
        "counts and relative scores for repositories the caller cannot read.\n\n"
        "Abstention happens BEFORE the model, never after. Handing a model weak evidence and asking it to decline politely is asking it to do the one thing\n"
        "it is worst at. When retrieval abstains there is no model call at all.\n\n"
        "The threshold is calibrated on cross-encoder scores, which are comparable across queries. Fusion ranks are not — a top RRF score of 0.05 means\n"
        "nothing in isolation — so when the reranker is down the rule changes shape rather than degrading silently.",
        size=13, colour="#e03131", align="left")

# ══════════════════════════════════════════════════════════════════════════════
# ZONE 4 — Documentation regeneration
# ══════════════════════════════════════════════════════════════════════════════
Y = 3060
zone(0, Y, 1160, 620, "4 · Documentation")

w1 = box(40, Y + 110, 240, 84, "push or merged PR\nHMAC verified against\nthe RAW body", *EXT, size=12)
w2 = box(320, Y + 110, 240, 84, "debounce 60s\nper (repo, ref)\na merge train ->\none job", *SVC, size=12)
w3 = box(600, Y + 110, 240, 84, "newest stored\nbundle\nno IR in the\nwebhook itself", *DAT, size=12)
arrow(w1, w2); arrow(w2, w3)

g1 = box(40, Y + 250, 240, 84, "deterministic first\nsignatures, graphs,\nendpoints, diagrams", *SVC, size=12)
g2 = box(320, Y + 250, 240, 84, "LLM prose second\none call per module\nvia the docgen route", *EXT, size=12)
g3 = box(600, Y + 250, 240, 84, "grounding check\nrejected prose is\ndropped, not shipped", *SEC, size=12)
arrow(w3, g1, sides=("b", "t"), via=[(720, Y + 220), (160, Y + 220)])
arrow(g1, g2); arrow(g2, g3)

o1 = box(320, Y + 390, 240, 74, "documents\n+ docs chunks\nqueryable copy", *DAT, size=12)
o2 = box(600, Y + 390, 240, 74, "pull request\nhumans review,\nnever a direct commit", *CI, size=12)
arrow(g3, o1, sides=("b", "t"), via=[(720, Y + 360), (440, Y + 360)])
arrow(g3, o2)

text_el(40, Y + 490, 1080, 80,
        "The in-repo copy is the half of the exit plan that survives the platform\n"
        "being switched off. Generated docs land as a pull request, and a human\n"
        "agrees to them.", size=13, colour="#e03131", align="left")

# ══════════════════════════════════════════════════════════════════════════════
# ZONE 5 — Tenancy and the security model
# ══════════════════════════════════════════════════════════════════════════════
Y = 3060
zone(1200, Y, 1160, 620, "5 · Tenancy and the security model")

box(1240, Y + 110, 500, 200,
    "Every tenant table carries org_id and FORCE ROW LEVEL SECURITY.\n"
    "Policies test  org_id = kna_current_org(),  a per-transaction\n"
    "setting. A SUPERUSER connection makes all of it SILENTLY inert —\n"
    "policies still exist, the invariant check still passes, and every\n"
    "tenant reads every other tenant's source.\n\n"
    "assertRlsEffective() runs at startup in every service and refuses\n"
    "to serve otherwise.", "#e03131", "#ffffff", size=12)

box(1780, Y + 110, 540, 200,
    "Reads that happen BEFORE a tenant is known need a narrow probe:\n\n"
    "withAuthProbe        bearer token -> principal\n"
    "                     naming the hash proves possession\n"
    "withIdentityProbe    provider subject -> principals\n"
    "                     authorised by HMAC, not by identity\n"
    "withRepoProbe        git remote -> repo, for webhooks\n\n"
    "Anything reading AFTER a principal exists uses withOrgContext.",
    "#1971c2", "#ffffff", size=12)

layers = [
    "1  minimise      only what a question needs leaves the repo",
    "2  scan          fail closed on a finding, before publish",
    "3  classify      sensitivity tier per chunk, restricted never embedded",
    "4  ACL in SQL    the caller's permissions as a query predicate",
    "5  injection     retrieved content wrapped as untrusted data",
    "6  audit         every read recorded by chunk id, breadth monitored",
]
box(1240, Y + 340, 1080, 190, "Six guardrail layers\n\n" + "\n".join(layers),
    "#e03131", "#fff5f5", size=12)

# ══════════════════════════════════════════════════════════════════════════════
# Legend
# ══════════════════════════════════════════════════════════════════════════════
Y = 3760
zone(0, Y, 2360, 230, "Legend")
lg = [("Platform service", SVC), ("Data store", DAT), ("CI job", CI),
      ("Outside the platform", EXT), ("Security boundary", SEC)]
for i, (name, col) in enumerate(lg):
    box(40 + i * 300, Y + 100, 250, 60, name, *col, size=13)
text_el(1600, Y + 100, 700, 66,
        "A dashed border means optional or not yet running.\nRed text is a failure this design exists to prevent.",
        size=13, align="left")

# ══════════════════════════════════════════════════════════════════════════════
out = {"type": "excalidraw", "version": 2, "source": "kna", "elements": E,
       "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"}, "files": {}}
for e in E:
    e.pop("_c", None)

emit("kna-system")

# ==============================================================================
# The simple canvas — one page, the tools by name, and where the data goes
# ==============================================================================
E.clear()

heading(40, 30, "KNA — system overview", 32)
text_el(40, 78, 1000, 24,
        "Node 22 and TypeScript, one pnpm monorepo. Everything below runs in Docker.",
        size=15, align="left", colour="#5c6670")

# --- who talks to it ---------------------------------------------------------
text_el(40, 132, 300, 20, "PRODUCERS", size=12, align="left", colour="#f08c00")
repo = box(40, 158, 210, 62, "Your repositories" + chr(10) + "GitHub", *EXT, size=13)
gha = box(40, 250, 210, 62, "GitHub Actions" + chr(10) + "analyse -> publish", *CI, size=13)

text_el(40, 392, 300, 20, "CONSUMERS", size=12, align="left", colour="#9c36b5")
edt = box(40, 418, 210, 62, "Editor" + chr(10) + "Claude Code / Cursor", *EXT, size=13)
trm = box(40, 510, 210, 62, "Terminal & browser" + chr(10) + "kna ask  ·  /admin", *EXT, size=13)

# --- the three services ------------------------------------------------------
text_el(380, 132, 400, 20, "SERVICES", size=12, align="left", colour="#1971c2")
api = box(380, 158, 250, 96, "API   :8080" + chr(10) + "Fastify 5" + chr(10) +
          "ingest · search · docs · admin", *SVC, size=13)
wrk = box(380, 288, 250, 96, "Worker" + chr(10) + "BullMQ" + chr(10) +
          "indexing · documentation", *SVC, size=13)
mcp = box(380, 418, 250, 96, "MCP server   :8081" + chr(10) + "streamable HTTP" + chr(10) +
          "7 read-only tools", *SVC, size=13)

# --- where the state lives ---------------------------------------------------
# Who reads and who writes is written inside each box rather than onto the arrows.
# Eight labels sharing one corridor land on top of each other; the same words sit
# perfectly well next to the thing they describe.
text_el(840, 132, 400, 20, "STATE AND MODELS", size=12, align="left", colour="#2f9e44")
pg = box(840, 158, 300, 100, "PostgreSQL 16" + chr(10) + "pgvector · HNSW · row-level security" +
         chr(10) + chr(10) + "worker writes it · API and MCP read it", *DAT, size=12)
rds = box(840, 288, 300, 100, "Redis" + chr(10) + "job queues" + chr(10) + chr(10) +
          "API adds jobs · worker takes them", *DAT, size=12)
obj = box(840, 418, 300, 100, "MinIO / S3" + chr(10) + "IR bundles, the system of record" +
          chr(10) + chr(10) + "API writes · worker reads", *DAT, size=12)
lite = box(840, 548, 300, 100, "LiteLLM  ->  OpenAI" + chr(10) + "embeddings, and the doc prose" +
           chr(10) + chr(10) + "called by the worker and by search", *EXT, size=12)

# --- data flow ---------------------------------------------------------------
# One vertical lane per arrow, inside a corridor with nothing in it, so no line is
# ever drawn across a box.
def mid(b): return b["y"] + b["height"] / 2

def lane(a, b, x):
    return dict(sides=("r", "l"), via=[(x, mid(a)), (x, mid(b))])

arrow(repo, gha, label="push / PR")
arrow(gha, api, label="signed IR bundle", colour="#e03131", **lane(gha, api, 300))
arrow(trm, api, label="HTTPS", **lane(trm, api, 332))
arrow(edt, mcp, label="MCP over HTTP")

for a, b, x in [(api, pg, 652), (api, rds, 675), (api, obj, 698),
                (wrk, rds, 721), (wrk, obj, 744), (wrk, pg, 767),
                (wrk, lite, 790), (mcp, pg, 812)]:
    arrow(a, b, **lane(a, b, x))

text_el(40, 700, 1100, 90,
        "Two paths, one index. Code arrives from CI as a signed bundle, is stored in object "
        "storage, and the worker turns it into a searchable index.\nQuestions arrive from an "
        "editor or a terminal and are answered from that same index — filtered in SQL by what "
        "the person asking is allowed to read.",
        size=14, align="left")

emit("kna-overview")
