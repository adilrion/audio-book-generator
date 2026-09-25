"""Generate a small, realistic test "book" PDF: running headers, page-number footers,
chapter headings, justified-ish body text with hyphenated line breaks and a TOC outline.

  python -m audiobook_worker.sample out.pdf [--chapters 3] [--no-toc]
"""
from __future__ import annotations

import argparse

import pymupdf as fitz

PARAS = [
    "The Industrial Revolution began in Britain in the late eighteenth century. It changed the way people "
    "worked, travelled and lived, and its effects are still felt in every modern economy today.",
    "Before the revolution, most goods were made by hand in small workshops. Mr. Hargreaves and his neighbours "
    "spun wool at home, and a single family might produce only a few yards of cloth in a week.",
    "Steam power transformed manufacturing. Factories could be built far from rivers, and machines could run "
    "day and night. Production increased dramatically, e.g. cotton output grew more than tenfold in forty years.",
    "Not everyone welcomed these changes. Skilled weavers lost their livelihoods, and working conditions in the "
    "early factories were often dangerous. Children as young as six worked long shifts beside heavy machinery.",
    "Railways followed soon after. By 1850 Britain had more than six thousand miles of track, connecting cities "
    "that had once been days apart. Trade, news and ideas travelled faster than ever before.",
]

TITLES = ["The Beginning", "Steam and Iron", "The Railway Age", "A New Society", "Legacy"]


def _wrap(text: str, font: fitz.Font, size: float, width: float) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if font.text_length(trial, size) <= width:
            cur = trial
            continue
        # try hyphenating long words across the break
        if len(w) >= 8 and cur:
            for cut in range(len(w) - 3, 3, -1):
                head = cur + " " + w[:cut] + "-"
                if font.text_length(head, size) <= width:
                    lines.append(head)
                    cur = w[cut:]
                    break
            else:
                lines.append(cur)
                cur = w
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def make_sample(path: str, chapters: int = 3, paras_per_chapter: int = 7, toc: bool = True) -> str:
    doc = fitz.open()
    font = fitz.Font("tiro")
    bold = fitz.Font("tibo")
    W, H, M = 432, 648, 54  # 6x9in trade paperback
    body, lead = 11.0, 15.0
    state = {"page": None, "y": 0.0, "n": 0}
    outline = []

    def new_page():
        p = doc.new_page(width=W, height=H)
        state["n"] += 1
        state["page"], state["y"] = p, M + 30
        p.insert_font(fontname="F0", fontbuffer=font.buffer)
        p.insert_font(fontname="F1", fontbuffer=bold.buffer)
        p.insert_text((M, M - 12), "THE SAMPLE BOOK OF INDUSTRY", fontname="F0", fontsize=8)
        num = str(state["n"])
        p.insert_text(((W - font.text_length(num, 9)) / 2, H - M + 24), num, fontname="F0", fontsize=9)
        return p

    new_page()
    state["page"].insert_text((M, 200), "The Sample Book of Industry", fontname="F1", fontsize=22)
    state["page"].insert_text((M, 230), "A short test volume", fontname="F0", fontsize=12)

    for c in range(chapters):
        p = new_page()
        title = f"Chapter {c + 1}: {TITLES[c % len(TITLES)]}"
        state["y"] += 40
        p.insert_text((M, state["y"]), title, fontname="F1", fontsize=18)
        outline.append([1, title, state["n"]])
        state["y"] += 36
        for k in range(paras_per_chapter):
            text = PARAS[(c + k) % len(PARAS)]
            lines = _wrap(text, font, body, W - 2 * M)
            if state["y"] + lead * 2 > H - M:
                p = new_page()
            for i, ln in enumerate(lines):
                if state["y"] > H - M:
                    p = new_page()
                x = M + (14 if i == 0 else 0)
                p.insert_text((x, state["y"]), ln, fontname="F0", fontsize=body)
                state["y"] += lead
            state["y"] += 6
    if toc:
        doc.set_toc(outline)
    doc.set_metadata({"title": "The Sample Book of Industry", "author": "Test Author"})
    doc.save(path, garbage=3, deflate=True)
    doc.close()
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--chapters", type=int, default=3)
    ap.add_argument("--paras", type=int, default=7)
    ap.add_argument("--no-toc", action="store_true")
    a = ap.parse_args()
    print(make_sample(a.out, a.chapters, a.paras, not a.no_toc))
