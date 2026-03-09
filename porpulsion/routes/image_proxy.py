"""
Registry image proxy route.

Registered at the Flask root (no blueprint prefix).

The pull secret server field is set to {apiUrl}/api/image-proxy, so containerd
constructs OCI paths relative to the *registry host*, not the server path.
When the pod image is `host/api/image-proxy/<registry>/<name>:<tag>`, containerd
sends requests to: {host}/v2/api/image-proxy/<registry>/<name>/manifests/<ref>

We register both paths to handle either case:
  - /api/image-proxy/<subpath>  (direct API call, e.g. health-check)
  - /v2/api/image-proxy/<subpath>  (containerd OCI path)

In both cases we strip the leading v2/ (if present) from the subpath, then
extract the registry host and forward to:
    https://<registry-host>/v2/<name>/manifests/<ref>

No upstream credentials are added — designed for network-restricted registries
reachable from the executing cluster without auth.
Protected by the existing /api/ Basic auth guard.
"""
import json
import logging
import ssl
import urllib.error
import urllib.request

from flask import Blueprint, Response, request

log = logging.getLogger("porpulsion.image_proxy")

bp = Blueprint("image_proxy", __name__)

_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]


@bp.route("/api/image-proxy/", defaults={"subpath": ""}, methods=_METHODS)
@bp.route("/api/image-proxy/<path:subpath>", methods=_METHODS)
@bp.route("/v2/api/image-proxy/", defaults={"subpath": ""}, methods=_METHODS)
@bp.route("/v2/api/image-proxy/<path:subpath>", methods=_METHODS)
def registry_image_proxy(subpath):
    # containerd prepends v2/ — strip it to get <registry-host>/<rest>
    path = subpath.lstrip("/")
    if path.startswith("v2/"):
        path = path[3:]

    if not path:
        return Response(
            json.dumps({"errors": [{"code": "UNAVAILABLE", "message": "no registry specified in path"}]}),
            503, content_type="application/json",
        )

    parts = path.split("/", 1)
    upstream_host = parts[0]
    rest = parts[1] if len(parts) > 1 else ""

    target = f"https://{upstream_host}/v2/{rest}"
    if request.query_string:
        target += "?" + request.query_string.decode()

    upstream_req = urllib.request.Request(target, method=request.method)
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
            json.dumps({"errors": [{"code": "UPSTREAM_ERROR", "message": str(exc)}]}),
            502, content_type="application/json",
        )
