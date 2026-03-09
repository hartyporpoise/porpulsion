"""
Registry image proxy route.

Registered at /api/image-proxy via the /api blueprint.
containerd's dockerconfigjson points its server key at {selfUrl}/api/image-proxy,
so OCI requests arrive as /api/image-proxy/v2/<name>/manifests/<ref> etc.

The upstream registry host and credentials come from the first
porpulsion-reg-* Secret (labeled porpulsion.io/registry-secret=true).
Protected by the existing /api/ Basic auth guard — no extra auth needed.
"""
import base64
import logging
import ssl
import urllib.error
import urllib.request

from flask import Blueprint, Response, request

from porpulsion.k8s.registry_proxy import get_upstream_registry

log = logging.getLogger("porpulsion.image_proxy")

bp = Blueprint("image_proxy", __name__)

_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]


@bp.route("/image-proxy/v2/", defaults={"subpath": ""}, methods=_METHODS)
@bp.route("/image-proxy/v2/<path:subpath>", methods=_METHODS)
def registry_image_proxy(subpath):
    upstream_host, creds = get_upstream_registry()
    if not upstream_host:
        return Response(
            '{"errors":[{"code":"UNAVAILABLE","message":"no upstream registry configured"}]}',
            503, content_type="application/json",
        )

    target = f"https://{upstream_host}/v2/{subpath}"
    if request.query_string:
        target += "?" + request.query_string.decode()

    upstream_req = urllib.request.Request(target, method=request.method)
    if creds:
        upstream_req.add_header(
            "Authorization",
            "Basic " + base64.b64encode(creds.encode()).decode(),
        )
    for hdr in ("Accept", "Content-Type", "Docker-Content-Digest", "Range"):
        val = request.headers.get(hdr)
        if val:
            upstream_req.add_header(hdr, val)
    body = request.get_data() or None
    if body:
        upstream_req.data = body

    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(upstream_req, context=ctx, timeout=120) as resp:
            data = resp.read()
            headers = {k: v for k, v in resp.headers.items()
                       if k.lower() not in ("transfer-encoding", "connection")}
            return Response(data, status=resp.status, headers=headers)
    except urllib.error.HTTPError as exc:
        data = exc.read()
        headers = {k: v for k, v in exc.headers.items()
                   if k.lower() not in ("transfer-encoding", "connection")}
        return Response(data, status=exc.code, headers=headers)
    except Exception as exc:
        log.warning("image-proxy upstream error: %s", exc)
        return Response(
            f'{{"errors":[{{"code":"UPSTREAM_ERROR","message":"{exc}"}}]}}',
            502, content_type="application/json",
        )
