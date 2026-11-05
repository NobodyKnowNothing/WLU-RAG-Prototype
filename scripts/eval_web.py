"""Measure the web demo's accuracy, comparing the Simple and Full retrieval modes.

Runs questions from data/web_eval.json against the Worker. Each run is stored in
results/web_eval.json under "<mode>:answers" or "<mode>:retrieval" (later runs replace earlier ones
of the same kind), and docs/eval.json is rebuilt from all stored runs for the site.

    python scripts/eval_web.py                                   # deployed Worker, both modes, full answers
    python scripts/eval_web.py --url http://127.0.0.1:8787 --modes simple --retrieve-only
    python scripts/eval_web.py --modes simple --ids E1,E2,L1,U1  # a subset, to save model calls
"""
import argparse
import json
import re
import statistics
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

root = Path(__file__).resolve().parent.parent
DEFAULT_URL = "https://wlu-rag-api.nobodyknownothing.workers.dev"
RESULTS = root / "results" / "web_eval.json"


def ask(url, item, mode, retrieve_only):
    body = {"question": item["question"], "mode": mode, "scope": "both", "retrieveOnly": retrieve_only}
    if item.get("sections"):
        body["sections"] = item["sections"]
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "pc141-eval/1.0"})  # Cloudflare blocks Python-urllib's default agent
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            if attempt == 2 or e.code < 500:
                return {"error": f"HTTP {e.code}: {e.read().decode()[:300]}"}
        time.sleep(5)


def page_hit(source, want):
    """A Laurier source from one of the expected pages, given as page ids or URL fragments."""
    return source["kind"] == "laurier" and any(w == source.get("page") or w in source.get("url", "") for w in want)


def section_hit(source, want):
    return source["kind"] == "pc141" and source["file"] == want["file"] and want["section"].lower() in source["section"].lower()


def score(item, r):
    """Per-question checks; None means the check does not apply to this question."""
    sources = r.get("sources", [])
    by_n = {s["n"]: s for s in sources}
    claims = r.get("pc141", []) + r.get("laurier", [])
    cited = [by_n[n] for c in claims for n in c["sources"] if n in by_n]
    want_pc, want_ul = item.get("pc141"), item.get("laurier")
    out = {
        "pc141_retrieved": any(section_hit(s, want_pc) for s in sources) if want_pc else None,
        "laurier_retrieved": any(page_hit(s, want_ul) for s in sources) if want_ul else None,
    }
    if "status" in r:
        unanswerable = item["group"] == "unanswerable"
        out.update(
            pc141_cited=any(section_hit(s, want_pc) for s in cited) if want_pc else None,
            laurier_cited=any(page_hit(s, want_ul) for s in cited) if want_ul else None,
            refused=r["status"] == "not_found" if unanswerable else None,
            answered=r["status"] != "not_found" if not unanswerable else None,
            claims=len(claims),
            verified_claims=sum(c["verified"] for c in claims),
        )
        # Kept so a failed quote check can be traced to the model or to the verifier.
        flagged = [{"text": c["text"], "quote": c["quote"], "sources": c["sources"], "issue": c.get("issue")} for c in claims if not c["verified"]]
        if flagged:
            out["unverified_claims"] = flagged
    return out


METRICS = [
    ("PC141 section retrieved (top 5)", "pc141_retrieved"),
    ("Laurier page retrieved", "laurier_retrieved"),
    ("Gives an answer (answerable questions)", "answered"),
    ("Answer cites the right PC141 section", "pc141_cited"),
    ("Answer cites the right Laurier page", "laurier_cited"),
    ("Says it can't verify (unanswerable questions)", "refused"),
]


def count(rows, key):
    vals = [r[key] for r in rows if r.get(key) is not None]
    return (sum(vals), len(vals)) if vals else None


def fmt(kn):
    return f"{kn[0]}/{kn[1]} ({round(100 * kn[0] / kn[1])}%)" if kn else None


def summarize(runs, items):
    """One column per mode; each cell uses the largest run of that mode that measured it."""
    table = {}
    for mode in ("simple", "full"):
        mode_runs = [run for key, run in runs.items() if key.startswith(f"{mode}:")]
        for name, key in METRICS:
            best = max((count([r for r in run["rows"] if "error" not in r], key) for run in mode_runs), key=lambda kn: kn[1] if kn else -1, default=None)
            table.setdefault(name, {})[mode] = fmt(best)
        answered = [r for run in mode_runs if run["kind"] == "answers" for r in run["rows"] if "error" not in r]
        claims = sum(r["claims"] for r in answered)
        table.setdefault("Statements whose quote checks out", {})[mode] = fmt((sum(r["verified_claims"] for r in answered), claims)) if claims else None
        secs = [r["seconds"] for r in answered]
        table.setdefault("Median seconds per answer", {})[mode] = round(statistics.median(secs), 1) if secs else None
    groups = {g: sum(i["group"] == g for i in items) for g in ("course", "email", "laurier", "policy", "search", "unanswerable")}
    return {
        "date": max(run["date"] for run in runs.values()),
        "questions": len(items),
        "summary": (
            f"{groups['course']} questions from the original evaluation set, the {groups['email']} admin questions from the project plan, "
            f"{groups['laurier']} questions on key student pages, {groups['policy']} on other university policies, {groups['search']} that need Laurier's site search "
            f"and {groups['unanswerable']} questions the sources cannot answer. "
            "Counts show how many questions each check applied to in that run."
        ),
        "metrics": table,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--modes", default="simple,full")
    ap.add_argument("--ids", help="comma-separated question ids (default: all)")
    ap.add_argument("--retrieve-only", action="store_true")
    ap.add_argument("--merge", action="store_true", help="keep the stored rows for questions not re-run")
    args = ap.parse_args()

    items = json.loads((root / "data" / "web_eval.json").read_text(encoding="utf-8"))
    chosen = [i for i in items if not args.ids or i["id"] in args.ids.split(",")]
    stored = json.loads(RESULTS.read_text(encoding="utf-8")) if RESULTS.exists() else {}
    runs = stored.get("runs", {})
    kind = "retrieval" if args.retrieve_only else "answers"
    order = [i["id"] for i in items]
    limited = False
    for mode in args.modes.split(","):
        rows = []
        for item in chosen:
            t0 = time.time()
            r = ask(args.url, item, mode, args.retrieve_only)
            if "error" in r and re.search(r"4006|daily_limit|daily free allocation", r["error"]):
                # Every further answer would fail the same way until 00:00 UTC; stop and keep what ran.
                print(f"{mode:6} {item['id']:4} stopped: the Workers AI daily allowance is used up (resets 00:00 UTC)", flush=True)
                limited = True
                break
            row = {"id": item["id"], "group": item["group"], "date": date.today().isoformat(), "url": args.url, "seconds": round(time.time() - t0, 1)}
            if "error" in r:
                row["error"] = r["error"]
            else:
                row.update(score(item, r))
                row["status"] = r.get("status")
                row["answer"] = r.get("answer")
                row["sources"] = [f"[{s['n']}] {s['title']} > {s['section']}" for s in r["sources"]]
            rows.append(row)
            flags = " ".join(f"{k}={v}" for k, v in row.items() if k in ("pc141_retrieved", "laurier_retrieved", "pc141_cited", "laurier_cited", "refused", "status", "error") and v is not None)
            print(f"{mode:6} {item['id']:4} {row['seconds']:5.1f}s {flags}", flush=True)
        key = f"{mode}:{kind}"
        if rows:
            if args.merge and key in runs:
                done = {r["id"] for r in rows}
                rows = sorted([r for r in runs[key]["rows"] if r["id"] not in done] + rows, key=lambda r: order.index(r["id"]))
            runs[key] = {"mode": mode, "kind": kind, "date": date.today().isoformat(), "url": args.url, "rows": rows}
        if limited:
            break

    RESULTS.parent.mkdir(exist_ok=True)
    RESULTS.write_text(json.dumps({"runs": runs}, indent=1, ensure_ascii=False), encoding="utf-8")
    summary = summarize(runs, items)
    (root / "docs" / "eval.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    width = max(map(len, summary["metrics"]))
    print("\n" + f"{'':{width}}  {'simple':>16}  {'full':>16}")
    for name, by in summary["metrics"].items():
        print(f"{name:{width}}  " + "  ".join(f"{'-' if by[m] is None else by[m]:>16}" for m in ("simple", "full")))


if __name__ == "__main__":
    main()
