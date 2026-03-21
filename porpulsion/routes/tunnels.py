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

# Hop-by-hop headers that must not be forwarded
_HOP_BY_HOP = {"host", "transfer-encoding", "connection", "keep-alive",
               "proxy-authenticate", "proxy-authorization", "te", "trailers",
               "upgrade"}


def _decompress(body: bytes, content_encoding: str) -> bytes:
    enc = content_encoding.lower().strip()
    if enc == "gzip":
        try:
            return gzip.decompress(body)
        except Exception:
            return body
    if enc in ("deflate", "zlib"):
        try:
            return zlib.decompress(body)
        except Exception:
            try:
                return zlib.decompress(body, -zlib.MAX_WBITS)
            except Exception:
                return body
    return body


def _proxy_via_channel(app_id: str, target_peer: str, port: int) -> Response:
    """Forward the current Flask request through the WS channel to the executing peer."""
    peer = state.peers.get(target_peer)
    if not peer:
        return jsonify({"error": "peer not connected"}), 503

    qs = request.query_string.decode()
    path = request.path
    if qs:
        path = path + "?" + qs

    fwd_headers = {k: v for k, v in request.headers if k.lower() not in _HOP_BY_HOP}
    fwd_headers["X-Forwarded-Host"] = request.host
    fwd_headers["X-Forwarded-Proto"] = request.headers.get("X-Forwarded-Proto", request.scheme)

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

    content_encoding = ""
    resp_headers = {}
    for k, v in result.get("headers", {}).items():
        kl = k.lower()
        if kl == "content-encoding":
            content_encoding = v
            continue  # strip; we decompress before returning
        if kl in _HOP_BY_HOP:
            continue
        resp_headers[k] = v

    body = base64.b64decode(result.get("body", ""))
    if content_encoding:
        body = _decompress(body, content_encoding)

    return Response(body, status=result.get("status", 502), headers=resp_headers)


def handle_vhost_proxy(subdomain: str) -> Response:
    """
    Dispatch a vhost-routed proxy request.

    Host format: {app_name}-{port}.{api_hostname}
    The subdomain passed here is the part before ".{api_hostname}",
    i.e. "{app_name}-{port}".

    Port is always the last hyphen-segment that is all digits.
    The remainder is matched by name against submitted RemoteApps in the
    agent namespace, using a runtime lookup to handle names with hyphens.
    """
    from porpulsion.k8s.store import list_remoteapp_crs, cr_to_dict

    # Strip port suffix: last "-NNN"
    m = re.match(r'^(.+)-(\d+)$', subdomain)
    if not m:
        return jsonify({"error": "invalid proxy hostname"}), 400
    app_name_raw, port = m.group(1), int(m.group(2))

    app_id = None
    target_peer = None
    try:
        for cr in list_remoteapp_crs(state.NAMESPACE):
            d = cr_to_dict(cr, "submitted")
            if d["name"] == app_name_raw:
                app_id = d["id"]
                target_peer = d["target_peer"]
                break
    except Exception as exc:
        log.warning("vhost proxy lookup failed: %s", exc)
        return jsonify({"error": "lookup failed"}), 500

    if not app_id:
        return jsonify({"error": "app not found"}), 404

    return _proxy_via_channel(app_id, target_peer, port)
