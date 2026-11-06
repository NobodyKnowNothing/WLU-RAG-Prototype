"""Is the Workers AI daily allowance available? Exit 0 = yes, 2 = used up, 1 = could not tell.

The allowance is shared by every model on the account, so one embedding call answers for the LLM
too. The probe asks the deployed Worker's /policy-search route for one section: that costs a single
query embedding (a fraction of a neuron), and when the allowance is gone the route still answers,
from keyword search, with "degraded" naming error 4006. Workers without the policy index fall back
to a Full-mode retrieval (one embedding and one rerank call). Each probe is appended to
results/ai_budget_probes.jsonl, which shows when the allowance actually comes back.

    python scripts/ai_budget.py
    python scripts/ai_budget.py --url http://127.0.0.1:8787
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parent.parent
DEFAULT_URL = "https://wlu-rag-api.nobodyknownothing.workers.dev"
LOG = root / "results" / "ai_budget_probes.jsonl"
EXHAUSTED = re.compile(r"4006|daily_limit|daily free allocation")


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "pc141-eval/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, {"error": text[:300]}


def probe(base):
    status, body = post(f"{base}/policy-search", {"query": "late penalty for assignments", "k": 1})
    if status in (404, 405) or "question must be" in str(body.get("error", "")):  # a Worker without the policy index
        status, body = post(base, {"question": "What is the late penalty?", "mode": "full", "scope": "pc141", "retrieveOnly": True})
        via = "full retrieval"
    else:
        via = "policy-search"
    detail = json.dumps(body)[:300]
    if status == 200 and not EXHAUSTED.search(str(body.get("degraded", ""))):
        return 0, via, "available"
    if EXHAUSTED.search(detail):
        return 2, via, "used up"
    return 1, via, f"HTTP {status}: {detail}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    args = ap.parse_args()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        code, via, state = probe(args.url.rstrip("/"))
    except Exception as e:  # network trouble: can't tell
        code, via, state = 1, "-", f"{type(e).__name__}: {e}"
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"at": now, "url": args.url, "via": via, "state": state}) + "\n")
    print(f"{now} Workers AI allowance: {state} (via {via})")
    sys.exit(code)


if __name__ == "__main__":
    main()
