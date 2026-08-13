import argparse
import csv
import hashlib
import json
import subprocess
from urllib.parse import urlparse
from pathlib import Path

ICON_DOMAIN_OVERRIDES = {
    "Gmail": "gmail.com",
    "Google Calendar": "calendar.google.com",
    "Google Drive": "drive.google.com",
    "Microsoft 365": "microsoft.com",
    "Atlassian Rovo": "atlassian.com",
}

def icon_domain(name: str, url: str | None) -> str | None:
    if name in icon_domain_overrides:
        return icon_domain_overrides[name]
    if url:
        parts = (urlparse(url).hostname or "").split(".")
        while len(parts) > 2 and parts[0] in {"api", "mcp", "www"}:
            parts.pop(0)
        return ".".join(parts)
    return None


def normalized_url(value: str) -> str:
    parsed = urlparse(value)
    return parsed._replace(
        scheme=parsed.scheme.lower(),
        netloc=parsed.netloc.lower(),
        path=parsed.path.rstrip("/"),
        query="",
        fragment="",
    ).geturl()

parser = argparse.ArgumentParser()
parser.add_argument("input")
parser.add_argument("--output", default="public/mcp-directory.json")
args = parser.parse_args()

with open(Path(__file__).with_name("mcp-oauth-capabilities.json"), encoding="utf-8") as source:
    oauth_metadata = json.load(source)
    oauth_capabilities = oauth_metadata["capabilities"]
with open(Path(__file__).with_name("mcp-icon-domains.json"), encoding="utf-8") as source:
    icon_domain_overrides = {**ICON_DOMAIN_OVERRIDES, **json.load(source)}

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
        name = record["name"].strip()
        auth = record["auth"].strip()
        oauth_capability = oauth_capabilities.get(normalized_url(url)) if url else None
        setup = "unsupported"
        entries.append(
            {
                "id": f"mcp-{index}",
                "name": name,
                "type": entry_type,
                "url": url or None,
                "auth": auth,
                "note": note or None,
                "categories": [value for value in record["category"].split(";") if value],
                "popularity": int(record["popularity"] or 0),
                "availability": availability,
                "iconDomain": icon_domain(name, url or None),
                "setup": setup,
                "oauthCapability": oauth_capability,
                "authMethods": [],
            }
        )

fingerprint_payload = [
    {
        "availability": entry["availability"],
        "auth": entry["auth"],
        "url": normalized_url(entry["url"]) if entry["url"] else "",
    }
    for entry in entries
]
catalog_fingerprint = hashlib.sha256(
    json.dumps(fingerprint_payload, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
if oauth_metadata.get("catalogFingerprint") != catalog_fingerprint:
    raise SystemExit("OAuth capability metadata is stale; rerun probe-mcp-oauth.py")

with open(args.output, "w", encoding="utf-8") as target:
    json.dump({"version": 1, "entries": entries}, target, ensure_ascii=False, separators=(",", ":"))

subprocess.run(["bunx", "biome", "format", "--write", args.output], check=True)
print(f"Wrote {len(entries)} entries to {args.output}")
