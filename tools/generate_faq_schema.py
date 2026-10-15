#!/usr/bin/env python3
"""Generate FAQPage JSON-LD from content/faq.md for LLM/search visibility.

Usage: python3 tools/generate_faq_schema.py  → prints a <script type="application/ld+json"> block.
Re-run after editing content/faq.md, then paste the output into index.html
(replaces the block between the FAQ-SCHEMA markers).
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAQ = ROOT / "content" / "faq.md"

def parse_qa(text):
    pairs, q, a = [], None, []
    for line in text.splitlines():
        m = re.match(r"\*\*Q\d*[:.]?\s*(.+?)\*\*\s*$", line.strip())
        if m:
            if q:
                pairs.append((q, " ".join(a).strip()))
            q, a = m.group(1).strip(), []
        elif q is not None:
            if line.strip().startswith(("A:", "A —", "A.")):
                a.append(line.strip()[2:].strip())
            elif line.strip():
                a.append(line.strip())
    if q:
        pairs.append((q, " ".join(a).strip()))
    return [(q, re.sub(r"\s+", " ", a)) for q, a in pairs if a]

def main():
    pairs = parse_qa(FAQ.read_text(encoding="utf-8"))
    schema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "name": "AI Pilot to Production — AI consulting FAQ",
        "url": "https://kudtarkar.life/",
        "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
            for q, a in pairs
        ],
    }
    out = json.dumps(schema, ensure_ascii=False, indent=2)
    if "--count" in sys.argv:
        print(f"{len(pairs)} Q/A pairs", file=sys.stderr)
    print(out)

if __name__ == "__main__":
    main()
