"""
Registry image proxy route.

Registered at the Flask root (no blueprint prefix) at /v2/<path>.

containerd implements the OCI Distribution spec: it takes the registry host
from the image reference and sends all requests to {host}/v2/<name>/...
When the image is `{agent-host}/cr.example.com/{name}:{tag}`, containerd
treats `{agent-host}` as the registry and sends:

    GET/HEAD /v2/cr.example.com/<name>/manifests/<ref>
    GET      /v2/cr.example.com/<name>/blobs/<digest>

We extract `cr.example.com` from the path and forward to:

    https://cr.example.com/v2/<name>/manifests/<ref>

Auth: the pull secret (porpulsion-image-proxy) stores Basic credentials for
this agent.  containerd presents those on every request, so this route is
covered by the /v2/ Basic Auth guard in agent.py.
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


@bp.route("/v2/", defaults={"subpath": ""}, methods=_METHODS)
@bp.route("/v2/<path:subpath>", methods=_METHODS)
def registry_image_proxy(subpath):
    path = subpath.lstrip("/")

    if not path:
        # OCI ping — let containerd know we speak OCI Distribution
        return Response(
            json.dumps({}),
            200,
            headers={"Content-Type": "application/json",
                     "Docker-Distribution-Api-Version": "registry/2.0"},
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
