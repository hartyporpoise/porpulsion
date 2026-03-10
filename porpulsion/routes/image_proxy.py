"""
Registry image proxy route.

Registered at the Flask root (no blueprint prefix) at /v2/<path>.

containerd implements the OCI Distribution spec: it takes the registry host
from the image reference and sends all requests to {host}/v2/<name>/...
When the image is `{agent-host}/cr.example.com/{name}:{tag}`, containerd
treats `{agent-host}` as the registry and sends:

    GET/HEAD /v2/cr.example.com/<name>/manifests/<ref>
    GET      /v2/cr.example.com/<name>/blobs/<digest>

We extract `cr.example.com` from the path. If the upstream registry is only
reachable from the submitting peer's network (private registry), we tunnel the
request over the WS channel to that peer. Otherwise we forward directly.

The submitting peer is identified by looking at which ExecutingApp on this
cluster uses an image whose registry host matches the upstream_host in the
request path.

Auth: the pull secret (porpulsion-image-proxy) stores Basic credentials for
this agent.  containerd presents those on every request, so this route is
covered by the /v2/ Basic Auth guard in agent.py.
"""
import base64
import json
import logging
import ssl
import urllib.error
import urllib.request

from flask import Blueprint, Response, request

log = logging.getLogger("porpulsion.image_proxy")

bp = Blueprint("image_proxy", __name__)

_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
_STRIP   = {"transfer-encoding", "connection", "content-length"}


def _find_source_peer_for_host(upstream_host: str) -> str | None:
    """
    Return the peer name that submitted a workload whose image is served from
    upstream_host, or None if no match is found.

    We look at all ExecutingApp CRs on this cluster and find one whose
    spec.image starts with '{upstream_host}/'.
    """
    try:
        from porpulsion import state
        from porpulsion.k8s.store import list_executingapp_crs, cr_to_dict
        for cr in list_executingapp_crs(state.NAMESPACE):
            d = cr_to_dict(cr, "executing")
            image = (d.get("spec") or {}).get("image", "")
            if image.startswith(upstream_host + "/"):
                return d.get("source_peer") or None
    except Exception as exc:
        log.debug("Could not look up source peer for %s: %s", upstream_host, exc)
    return None


def _proxy_via_channel(peer_name: str, method: str, target: str,
                       fwd_headers: dict) -> Response | None:
    """
    Tunnel an OCI request through the WS channel to peer_name (the submitting
    agent, which has network access to the upstream registry).

    Returns a Flask Response on success, or None if the channel is unavailable.
    """
    try:
        from porpulsion.channel import get_channel
        ch = get_channel(peer_name, wait=5.0)
        result = ch.call("image-proxy/request", {
            "method":  method,
            "url":     target,
            "headers": fwd_headers,
        }, timeout=130)

        status       = result.get("status", 502)
        resp_headers = result.get("headers", {})
        body         = base64.b64decode(result.get("body", ""))

        flask_resp = Response(body, status=status, headers=resp_headers)
        if "Content-Length" in resp_headers:
            flask_resp.headers.set("Content-Length", resp_headers["Content-Length"])
        return flask_resp
    except Exception as exc:
        log.warning("image-proxy channel tunnel to %s failed: %s", peer_name, exc)
        return None


@bp.route("/v2/", defaults={"subpath": ""}, methods=_METHODS)
@bp.route("/v2/<path:subpath>", methods=_METHODS)
def registry_image_proxy(subpath):
    path = subpath.lstrip("/")

    if not path:
        # OCI ping
        return Response(
            json.dumps({}),
            200,
            headers={"Content-Type": "application/json",
                     "Docker-Distribution-Api-Version": "registry/2.0"},
        )

    parts         = path.split("/", 1)
    upstream_host = parts[0]
    rest          = parts[1] if len(parts) > 1 else ""

    target = f"https://{upstream_host}/v2/{rest}"
    if request.query_string:
        target += "?" + request.query_string.decode()

    fwd_headers = {}
    for hdr in ("Accept", "Content-Type", "Docker-Content-Digest", "Range"):
        val = request.headers.get(hdr)
        if val:
            fwd_headers[hdr] = val

    # Try to tunnel through the submitting peer's WS channel first.
    # This handles private registries that are only reachable from the
    # submitting cluster's network.
    peer_name = _find_source_peer_for_host(upstream_host)
    if peer_name:
        resp = _proxy_via_channel(peer_name, request.method, target, fwd_headers)
        if resp is not None:
            return resp
        log.warning("image-proxy: channel tunnel to %r failed, falling back to direct", peer_name)

    # Fall back to direct outbound HTTP (works for public registries).
    upstream_req = urllib.request.Request(target, method=request.method)
    for k, v in fwd_headers.items():
        upstream_req.add_header(k, v)
    upstream_req.add_unredirected_header("Accept-Encoding", "identity")
    body = request.get_data() or None
    if body:
        upstream_req.data = body

    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(upstream_req, context=ctx, timeout=120) as resp:
            data = resp.read()
            headers = {k: v for k, v in resp.headers.items()
                       if k.lower() not in _STRIP}
            flask_resp = Response(data, status=resp.status, headers=headers)
            if "Content-Length" in resp.headers:
                flask_resp.headers.set("Content-Length", resp.headers["Content-Length"])
            return flask_resp
    except urllib.error.HTTPError as exc:
        data = exc.read()
        headers = {k: v for k, v in exc.headers.items()
                   if k.lower() not in _STRIP}
        return Response(data, status=exc.code, headers=headers)
    except Exception as exc:
        log.warning("image-proxy upstream error: %s", exc)
        return Response(
            json.dumps({"errors": [{"code": "UPSTREAM_ERROR", "message": str(exc)}]}),
            502, content_type="application/json",
        )
