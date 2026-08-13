import argparse
import csv
import json
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("input")
parser.add_argument("--output", default="public/mcp-directory.json")
args = parser.parse_args()

entries = []
with open(args.input, newline="", encoding="utf-8-sig") as source:
    for index, record in enumerate(csv.DictReader(source), 1):
        note = record["note"].strip()
        url = record["url"].strip()
        entry_type = record["type"].strip()
        availability = (
            "local"
            if entry_type == "local"
            else "fixed"
            if url
            else "tenant"
            if note.lower().startswith("per-tenant url")
            else "unavailable"
        )
        entries.append(
            {
                "id": f"mcp-{index}",
                "name": record["name"].strip(),
                "type": entry_type,
                "url": url or None,
                "auth": record["auth"].strip(),
                "note": note or None,
                "categories": [value for value in record["category"].split(";") if value],
                "popularity": int(record["popularity"] or 0),
                "availability": availability,
            }
        )

with open(args.output, "w", encoding="utf-8") as target:
    json.dump({"version": 1, "entries": entries}, target, ensure_ascii=False, separators=(",", ":"))

subprocess.run(["bunx", "biome", "format", "--write", args.output], check=True)
print(f"Wrote {len(entries)} entries to {args.output}")
