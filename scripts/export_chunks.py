"""Split the course PDFs in files/ into section chunks for the Cloudflare Worker (worker/src/chunks.json).

Headings are detected from the PDF fonts: a line set entirely in bold is a heading, numbered
headings ("3.2 Bounding") nest by their number, and MyLearningSpace news posts ("• Introduction"
followed by "Posted by ...") start a new top-level section. Each chunk keeps its document title,
section path and pages so the Worker can cite "document > section, p. n".
"""
import json
import re
from pathlib import Path

from pypdf import PdfReader

root = Path(__file__).resolve().parent.parent

# Names shown in citations; other files fall back to their file name.
TITLES = {
    "PC141LabSyllabus2026FRAG.pdf": "PC141 Lab Syllabus (Fall 2026)",
    "PC141labRules.pdf": "PC141 Lab Announcements (MyLS)",
    "PC141tutorialRules.pdf": "PC141 Tutorial Announcements (MyLS)",
    "PC141labRAG.pdf": "PC141 Lab Manual: Estimation and Bounding",
}
MAX_CHARS = 1800
# MyLearningSpace page furniture that is not course content.
CHROME = {"News", "Updates", "Calendar", "Role Switch", "Powered by", "Show All News Items", "Edited"}
NUMBERED = re.compile(r"^(\d+(?:\.\d+)*|[A-Z]\.\d+)\s+[A-Z]")
BOLD = re.compile(r"bold|black|heavy", re.I)
SYMBOL = re.compile(r"symbol|courier|wingding", re.I)  # bullet glyph fonts


def page_lines(page):
    """Returns the page's lines as (text, all_bold, font_size)."""
    lines, frags = [], []

    def visit(text, cm, tm, font, size):
        for i, part in enumerate(text.split("\n")):
            if i:
                lines.append(list(frags))
                frags.clear()
            if part:
                name = (font or {}).get("/BaseFont", "")
                if SYMBOL.search(name) and part.strip() == "o":
                    part = "◦"  # Word's Courier "o" sub-bullet
                frags.append((part, name, size * (abs(tm[0]) or 1)))

    page.extract_text(visitor_text=visit)
    lines.append(frags)
    out = []
    for fr in lines:
        text = re.sub(r"\s+", " ", "".join(p for p, _, _ in fr)).strip()
        words = [(f, s) for p, f, s in fr if p.strip() and not SYMBOL.search(f)]
        if text:
            out.append((text, bool(words) and all(BOLD.search(f) for f, _ in words), max((s for _, s in words), default=0)))
    return out


def heading_kind(text, bold):
    """Classifies a line as a numbered heading (its depth), a plain heading, or body text (None)."""
    if not bold or not 2 < len(text) <= 80 or not re.search(r"[A-Za-z]{2}", text):
        return None
    if text.endswith((".", ",", ";")) or "@" in text or re.search(r"\bDay\b.*\bTime\b", text):
        return None  # sentences, emails, schedule table header rows
    if text.endswith(":") and len(text.split()) < 3 and not text[:-1].isupper():
        return None  # "Name:" labels
    if re.match(r"^Appendix [A-Z]\b", text):
        return 1
    if m := NUMBERED.match(text):
        if re.search(r"(\. ){2,}|\s\d+$", text):
            return None  # table of contents entry
        return m.group(1).count(".") + 1
    return "plain"


def split_sections(path):
    reader = PdfReader(str(path))
    pages = [page_lines(p) for p in reader.pages]
    firsts = [ls[0][0] for ls in pages if ls]
    headers = {t for t in firsts if firsts.count(t) > 1}  # running page headers
    sizes = [round(s) for ls in pages for _, _, s in ls]
    body_size = max(set(sizes), key=sizes.count)
    # In documents with numbered headings ("3.2 Bounding"), the numbers are the section structure and
    # bold lines at body size are paragraph labels or table cells, not headings.
    numbered = sum(isinstance(heading_kind(t, b), int) for ls in pages for t, b, _ in ls) >= 3

    lines = []  # (text, bold, size, page)
    for pno, ls in enumerate(pages, start=1):
        for i, (text, bold, size) in enumerate(ls):
            if i == 0 and (text in headers or (numbered and not bold and NUMBERED.match(text))):
                continue  # running page header
            if text in CHROME or text.isdigit():
                continue
            if lines and lines[-1][0] == text:
                if bold:  # a running header repeated by the real heading: keep the heading
                    lines[-1] = (text, bold, size, pno)
                continue
            lines.append((text, bold, size, pno))

    sections, stack, cur = [], [], {"path": ["Header"], "pages": [], "lines": []}
    seen_body = False

    def flush():
        if cur["lines"]:
            sections.append(dict(cur))

    for i, (text, bold, size, pno) in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else ("", False, 0, pno)
        post = re.match(r"^•\s*(.+)$", text)
        kind = heading_kind(text, bold)
        if numbered and kind == "plain":
            kind = 1 if size > body_size * 1.15 else None
        if post and nxt[0].startswith("Posted by"):
            level, title = 0, post.group(1)
        elif kind is not None and seen_body:
            if kind != "plain":
                level = kind
            elif text.rstrip(":").isupper() or heading_kind(nxt[0], nxt[1]) == "plain":
                level = 1  # a heading over headings (or an ALL CAPS one) groups those that follow
            else:
                level = 2
            title = text.rstrip(":")
        else:
            seen_body = seen_body or bool(post) or (not bold and size <= body_size * 1.1)
            cur["lines"].append(text)
            if pno not in cur["pages"]:
                cur["pages"].append(pno)
            continue
        flush()
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, title))
        cur = {"path": [t for _, t in stack], "pages": [pno], "lines": []}
    flush()
    return sections


def to_chunks(path):
    title = TITLES.get(path.name, path.name)
    chunks = []
    for sec in split_sections(path):
        parts, buf = [], ""
        for line in sec["lines"]:
            if buf and len(buf) + len(line) > MAX_CHARS:
                parts.append(buf)
                buf = ""
            buf = f"{buf}\n{line}" if buf else line
        parts.append(buf)
        section = " > ".join(sec["path"])
        for text in parts:
            chunks.append(
                {
                    "id": f"{path.stem}#{len(chunks) + 1}",
                    "kind": "pc141",
                    "source": path.name,
                    "title": title,
                    "section": section,
                    "pages": sec["pages"],
                    "text": text,
                    "enriched": f"{title} | {section}\n{text}",
                }
            )
    return chunks


if __name__ == "__main__":
    chunks = [c for f in sorted((root / "files").glob("*.pdf")) for c in to_chunks(f)]
    out = root / "worker" / "src" / "chunks.json"
    out.write_text(json.dumps(chunks, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"wrote {len(chunks)} chunks to {out}")
