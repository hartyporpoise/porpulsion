import base64
import gzip
import logging
import re
import zlib

from flask import Blueprint, request, jsonify, Response

from porpulsion import state
from porpulsion.channel import get_channel

log = logging.getLogger("porpulsion.routes.tunnels")

bp = Blueprint("tunnels", __name__)

_PROXY_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]

# Hop-by-hop headers that must not be forwarded
_HOP_BY_HOP = {"host", "transfer-encoding", "connection", "keep-alive",
               "proxy-authenticate", "proxy-authorization", "te", "trailers",
               "upgrade"}


def _rewrite_body(body: bytes, content_type: str, proxy_prefix: str) -> bytes:
    """
    Rewrite root-relative URLs in HTML, JS, and CSS so they route through the
    tunnel instead of hitting the browser origin directly.

    Root-relative paths (/foo) are not affected by <base href> — browsers
    resolve them against the page origin, producing 404s through the tunnel.
    We rewrite them to be prefix-absolute so all asset types work: static sites,
    React/Vue/Astro apps, MinIO console, database UIs, etc.
    """
    prefix_b = proxy_prefix.encode()
    ct = content_type.lower().split(";")[0].strip()

    if ct == "text/html":
        # <base href> handles relative paths (no leading /); inject it first
        if b"<head" in body:
            base_tag = f'<base href="{proxy_prefix}/">'.encode()
            body = re.sub(rb"<head([^>]*)>", rb"<head\1>" + base_tag, body, count=1)
        # Rewrite root-relative attribute values: href="/...", src="/...", action="/..."
        body = re.sub(
            rb'((?:src|href|action)=")(/[^"]*")',
            lambda m: m.group(1) + prefix_b + m.group(2),
            body,
        )
        # srcset can have multiple comma-separated "url [descriptor]" entries
        def _rewrite_srcset(m):
            parts = m.group(1).split(b",")
            out = []
            for part in parts:
                stripped = part.strip()
                if stripped.startswith(b"/"):
                    tokens = stripped.split(b" ", 1)
                    tokens[0] = prefix_b + tokens[0]
                    part = b" ".join(tokens)
                out.append(part)
            return b'srcset="' + b",".join(out) + b'"'
        body = re.sub(rb'srcset="([^"]*)"', _rewrite_srcset, body)

    elif ct in ("application/javascript", "text/javascript", "application/x-javascript"):
        # Rewrite quoted root-relative paths in JS bundles.
        # Catches: fetch('/api/...'), import('/chunk.js'), src: '/img/logo.png'
        # Excludes: "//..." (protocol-relative), "/ " (space after slash)
        body = re.sub(
            rb"""(["'])(/(?![/"' ])[^"']*)(\1)""",
            lambda m: m.group(1) + prefix_b + m.group(2) + m.group(3),
            body,
        )

    elif ct == "text/css":
        # Rewrite url(/...) in CSS
        body = re.sub(
            rb'url\((/[^)]*)\)',
            lambda m: b"url(" + prefix_b + m.group(1) + b")",
            body,
        )

    return body


# -- User-facing proxy (submitting side)
#
# Requests to /remoteapp/<id>/proxy/<port>[/<path>] are forwarded over the
# WebSocket channel to the executing peer, which resolves the pod Service and
# makes the real HTTP call. Responses are URL-rewritten so root-relative paths
# in web UIs route back through the tunnel instead of hitting the browser origin.

@bp.route("/remoteapp/<app_id>/proxy/<int:port>",
          defaults={"subpath": ""},
          methods=_PROXY_METHODS)
@bp.route("/remoteapp/<app_id>/proxy/<int:port>/<path:subpath>",
          methods=_PROXY_METHODS)
def proxy_remoteapp(app_id, port, subpath):
    """User-facing: proxy HTTP through to a pod on the peer cluster."""
    from porpulsion.k8s.store import get_cr_by_app_id, cr_to_dict
    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None or side != "submitted":
        return jsonify({"error": "app not found"}), 404

    d = cr_to_dict(cr, side)
    peer = state.peers.get(d["target_peer"])
    if not peer:
        return jsonify({"error": "peer not connected"}), 503

    scheme = request.headers.get("X-Forwarded-Proto", request.scheme)
    proxy_prefix = f"{scheme}://{request.host}/api/remoteapp/{app_id}/proxy/{port}"
    proxy_path_prefix = f"/api/remoteapp/{app_id}/proxy/{port}"

    qs = request.query_string.decode()
    path = (subpath + ("?" + qs if qs else "")) if subpath else ("?" + qs if qs else "")
    fwd_headers = {k: v for k, v in request.headers if k.lower() not in _HOP_BY_HOP}
    # Tell the upstream app where it's being served from.
    # Apps that honour X-Forwarded-Prefix (Next.js, many frameworks) generate
    # correct absolute URLs and won't need the body rewriting below.
    fwd_headers["X-Forwarded-Host"] = request.host
    fwd_headers["X-Forwarded-Proto"] = scheme
    fwd_headers["X-Forwarded-Prefix"] = proxy_path_prefix

    try:
        ch = get_channel(peer.name)
        result = ch.call("proxy/request", {
            "app_id": app_id,
            "port": port,
            "method": request.method,
            "path": path,
            "headers": fwd_headers,
            "body": base64.b64encode(request.get_data()).decode(),
        }, timeout=30)
    except Exception as exc:
        return jsonify({"error": f"failed to reach peer: {exc}"}), 502

    resp_headers = {}
    content_encoding = ""
    content_type = ""
    for k, v in result.get("headers", {}).items():
        kl = k.lower()
        if kl == "content-encoding":
            content_encoding = v.lower().strip()
            continue  # strip; we decompress below so downstream gets plain bytes
        if kl in _HOP_BY_HOP:
            continue
        if kl == "location":
            # Absolute redirect from upstream origin → rewrite to proxy prefix
            v = re.sub(r"^https?://[^/]*", proxy_prefix, v)
            # Root-relative redirect → prepend proxy path prefix
            if v.startswith("/") and not v.startswith(proxy_path_prefix):
                v = proxy_path_prefix + v
        if kl == "content-type":
            content_type = v
        resp_headers[k] = v

    body = base64.b64decode(result.get("body", ""))
    if content_encoding == "gzip":
        try:
            body = gzip.decompress(body)
        except Exception:
            pass
    elif content_encoding in ("deflate", "zlib"):
        try:
            body = zlib.decompress(body)
        except Exception:
            try:
                body = zlib.decompress(body, -zlib.MAX_WBITS)
            except Exception:
                pass

    body = _rewrite_body(body, content_type, proxy_prefix)
    return Response(body, status=result.get("status", 502), headers=resp_headers)
