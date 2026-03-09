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


# -- User-facing proxy (submitting side)
#
# Any request to /remoteapp/<id>/proxy/<port>[/<path>] is forwarded over
# mTLS to the executing peer at /remoteapp/<id>/proxy-remote/<port>[/<path>],
# which resolves the pod and makes the real HTTP call.

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

    qs = request.query_string.decode()
    path = (subpath + ("?" + qs if qs else "")) if subpath else ("?" + qs if qs else "")
    fwd_headers = {k: v for k, v in request.headers if k.lower() not in _HOP_BY_HOP}

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

    scheme = request.headers.get("X-Forwarded-Proto", request.scheme)
    proxy_prefix = f"{scheme}://{request.host}/api/remoteapp/{app_id}/proxy/{port}"
    resp_headers = {}
    content_encoding = ""
    for k, v in result.get("headers", {}).items():
        if k.lower() == "content-encoding":
            content_encoding = v.lower().strip()
            continue  # strip hop-by-hop; we decompress below
        if k.lower() in _HOP_BY_HOP:
            continue
        if k.lower() == "location":
            v = re.sub(r'^https?://[^/]*', proxy_prefix, v)
        resp_headers[k] = v
    body = base64.b64decode(result.get("body", ""))
    # Decompress the body since we stripped content-encoding from the headers
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
                body = zlib.decompress(body, -zlib.MAX_WBITS)  # raw deflate
            except Exception:
                pass
    content_type = resp_headers.get("Content-Type", "")
    if "text/html" in content_type and b"<head" in body:
        base_tag = f'<base href="{proxy_prefix}/">'.encode()
        body = re.sub(rb"<head([^>]*)>", rb"<head\1>" + base_tag, body, count=1)
        # Rewrite root-relative URLs (src="/...", href="/...") — <base> doesn't affect these.
        prefix_b = proxy_prefix.encode()
        body = re.sub(rb'(src|href)="(/[^"]*)"', lambda m: m.group(1) + b'="' + prefix_b + m.group(2) + b'"', body)
    return Response(body, status=result.get("status", 502), headers=resp_headers)


