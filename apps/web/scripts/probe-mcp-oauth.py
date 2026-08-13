import argparse
import concurrent.futures
import hashlib
import ipaddress
import json
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime

parser = argparse.ArgumentParser()
parser.add_argument("catalog")
parser.add_argument("--output", default="mcp-oauth-capabilities.json")
parser.add_argument("--workers", type=int, default=8)
args = parser.parse_args()

entries = json.load(open(args.catalog, encoding="utf-8"))["entries"]
context = ssl.create_default_context()


def safe_url(url: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return False
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
        return bool(addresses) and all(
            ipaddress.ip_address(address[4][0]).is_global for address in addresses
        )
    except (OSError, ValueError):
        return False


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        if not safe_url(new_url):
            raise urllib.error.HTTPError(new_url, code, "unsafe redirect", headers, file)
        return super().redirect_request(request, file, code, message, headers, new_url)


opener = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=context), SafeRedirectHandler()
)


def get_json(url: str):
    if not safe_url(url):
        return None
    try:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "supermemory-mcp-directory-audit/1.0",
            },
        )
        with opener.open(request, timeout=6) as response:
            if response.status != 200:
                return None
            value = json.loads(response.read(512_000))
            return value if isinstance(value, dict) else None
    except Exception:
        return None


def normalized_resource(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    return urllib.parse.urlunsplit(
        (parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/"), "", "")
    )


def catalog_fingerprint(values) -> str:
    relevant = [
        {
            "availability": entry["availability"],
            "auth": entry["auth"],
            "url": normalized_resource(entry.get("url") or ""),
        }
        for entry in values
    ]
    payload = json.dumps(relevant, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def probe(entry):
    if entry["availability"] != "fixed" or entry["auth"] != "auth_required":
        return normalized_resource(entry.get("url") or ""), None
    parsed = urllib.parse.urlsplit(entry["url"])
    origin = f"{parsed.scheme}://{parsed.netloc}"
    path = parsed.path.rstrip("/")
    protected_resource_urls = []
    if path:
        protected_resource_urls.append(origin + "/.well-known/oauth-protected-resource" + path)
    protected_resource_urls.append(origin + "/.well-known/oauth-protected-resource")
    metadata = next(
        (value for url in protected_resource_urls if (value := get_json(url))), None
    )
    if not metadata or normalized_resource(str(metadata.get("resource", ""))) != normalized_resource(entry["url"]):
        return normalized_resource(entry["url"]), None

    preregistered = False
    for server in metadata.get("authorization_servers") or []:
        if not isinstance(server, str):
            continue
        issuer = server.rstrip("/")
        issuer_url = urllib.parse.urlsplit(issuer)
        candidates = [
            issuer + "/.well-known/oauth-authorization-server",
            issuer + "/.well-known/openid-configuration",
        ]
        if issuer_url.path and issuer_url.path != "/":
            candidates.insert(
                0,
                f"{issuer_url.scheme}://{issuer_url.netloc}/.well-known/oauth-authorization-server{issuer_url.path}",
            )
        authorization_metadata = next(
            (value for url in candidates if (value := get_json(url))), None
        )
        if not authorization_metadata:
            continue
        if authorization_metadata.get("registration_endpoint") or authorization_metadata.get(
            "client_id_metadata_document_supported"
        ):
            return normalized_resource(entry["url"]), "dcr"
        preregistered = True
    return normalized_resource(entry["url"]), "preregistered" if preregistered else None


candidates = [
    entry
    for entry in entries
    if entry["availability"] == "fixed" and entry["auth"] == "auth_required"
]
capabilities = {}
with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
    for entry_id, capability in executor.map(probe, candidates):
        if capability:
            capabilities[entry_id] = capability

output = {
    "generatedAt": datetime.now(UTC).isoformat(),
    "catalogEntries": len(entries),
    "probedEntries": len(candidates),
    "catalogFingerprint": catalog_fingerprint(entries),
    "capabilities": capabilities,
}
with open(args.output, "w", encoding="utf-8") as target:
    json.dump(output, target, indent=2, sort_keys=True)
print(
    f"Probed {len(candidates)} entries: "
    f"{sum(value == 'dcr' for value in capabilities.values())} DCR, "
    f"{sum(value == 'preregistered' for value in capabilities.values())} preregistered"
)
