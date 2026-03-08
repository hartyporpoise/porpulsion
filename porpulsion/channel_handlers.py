"""
Message handlers for incoming WebSocket frames.

Each function is registered on a PeerChannel by channel._register_handlers().
Handlers for request-type messages return a dict payload (sent as the reply).
Handlers for push-type messages return None.

All inbound peer authentication has already been done by the WS endpoint
before the socket is handed to the channel - these handlers trust the caller.
"""
import base64
import logging
from datetime import datetime, timezone

log = logging.getLogger("porpulsion.channel_handlers")


# -- RemoteApp

def handle_remoteapp_receive(payload: dict) -> dict:
    """Accept a RemoteApp submission from a peer."""
    from porpulsion import state, tls
    from porpulsion.models import RemoteApp, RemoteAppSpec
    from porpulsion.routes.workloads import _check_resource_quota
    from porpulsion.notifications import add_notification
    from porpulsion.k8s.store import create_executingapp_cr

    if not state.settings.allow_inbound_remoteapps:
        raise RuntimeError("inbound workloads are disabled on this agent")

    spec = RemoteAppSpec.from_dict(payload.get("spec", {}))
    source_peer = payload.get("source_peer", "unknown")
    quota_err = _check_resource_quota(spec, source_peer=source_peer)
    if quota_err:
        add_notification(
            level="error",
            title=f"Workload rejected from {source_peer}",
            message=f"{payload.get('name', '?')!r}: {quota_err}",
        )
        raise RuntimeError(quota_err)

    app_id = payload.get("id") or __import__("uuid").uuid4().hex[:8]
    try:
        from porpulsion.k8s.store import validate_remoteapp_spec
        val_err = validate_remoteapp_spec(state.NAMESPACE, app_id, payload.get("name", "app"), spec.to_dict(), source_peer)
        if val_err:
            raise RuntimeError(f"spec invalid: {val_err}")
    except RuntimeError:
        raise
    except Exception as _ve:
        log.debug("CRD spec validation skipped: %s", _ve)
    source = state.peers.get(source_peer)

    if state.settings.require_remoteapp_approval:
        entry = {
            "id": app_id,
            "name": payload["name"],
            "spec": spec.to_dict(),
            "source_peer": source_peer,
            "callback_url": source_peer,
            "since": datetime.now(timezone.utc).isoformat(),
        }
        state.pending_approval[app_id] = entry
        log.info("App %s queued for approval (via channel) from %s", app_id, source_peer)
        tls.save_state_configmap(state.NAMESPACE, state.settings, state.pending_approval)
        add_notification(
            level="info",
            title="Approval required",
            message=f"{payload['name']!r} from {source_peer} is waiting for your approval.",
        )
        return {"id": app_id, "status": "pending_approval"}

    # Create ExecutingApp CR - the CR watcher drives workload execution from here
    cr_name = create_executingapp_cr(
        state.NAMESPACE, app_id, payload["name"], spec.to_dict(), source_peer,
    )
    log.info("Received app %s (%s) via channel from %s (cr=%s)", payload["name"], app_id, source_peer, cr_name or "none")
    ra = RemoteApp(name=payload["name"], spec=spec, source_peer=source_peer, id=app_id)
    if cr_name:
        ra.cr_name = cr_name
    return ra.to_dict()


def handle_remoteapp_status(payload: dict):
    """Status update pushed from executor back to the submitting peer."""
    from porpulsion import state
    from porpulsion.notifications import add_notification
    from porpulsion.k8s.store import get_cr_by_app_id, update_remoteapp_cr_status, cr_to_dict

    app_id     = payload.get("id") or payload.get("app_id", "")
    status     = payload.get("status", "")

    # Update the RemoteApp CR status (this is the submitting side)
    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is not None and side == "submitted":
        d = cr_to_dict(cr, side)
        try:
            update_remoteapp_cr_status(state.NAMESPACE, d["cr_name"], status, app_id)
        except Exception as e:
            log.debug("CR status update skipped: %s", e)
        log.info("Status update for %s: %s (via channel)", app_id, status)
        if status.startswith("Failed") or status == "Timeout":
            add_notification(
                level="error",
                title=f"Workload failed: {d['name']}",
                message=f"{d['name']!r} on {d['target_peer']} -> {status}.",
            )
    else:
        log.debug("Status update for unknown app %s: %s", app_id, status)


def handle_remoteapp_delete(payload: dict) -> dict:
    """Delete a RemoteApp on this (executing) side."""
    from porpulsion import state
    from porpulsion.k8s.store import get_ea_cr_by_app_id, delete_executingapp_cr, cr_to_dict

    app_id = payload.get("id", "")
    ea_cr = get_ea_cr_by_app_id(state.NAMESPACE, app_id)
    if ea_cr is None:
        log.info("handle_remoteapp_delete: EA for %s already gone — treating as success", app_id)
        return {"ok": True}

    d = cr_to_dict(ea_cr, "executing")
    # Delete the CR - the CR watcher (DELETED) handles workload cleanup and peer notification
    delete_executingapp_cr(state.NAMESPACE, d["cr_name"])
    log.info("Deleted executing app %s (via channel)", app_id)
    return {"ok": True}


def handle_remoteapp_scale(payload: dict) -> dict:
    """Scale a RemoteApp on this (executing) side."""
    from porpulsion import state
    from porpulsion.k8s.executor import scale_workload
    from porpulsion.k8s.store import get_ea_cr_by_app_id, cr_to_dict
    from porpulsion.models import RemoteApp, RemoteAppSpec

    app_id   = payload.get("id", "")
    replicas = payload.get("replicas")
    ea_cr = get_ea_cr_by_app_id(state.NAMESPACE, app_id)
    if ea_cr is None:
        raise RuntimeError("app not found")

    d = cr_to_dict(ea_cr, "executing")
    ra = RemoteApp(
        id=app_id, name=d["name"],
        spec=RemoteAppSpec.from_dict(d.get("spec", {})),
        source_peer=d["source_peer"],
    )
    scale_workload(ra, int(replicas))
    return {"ok": True, "replicas": int(replicas)}


def handle_remoteapp_detail(payload: dict) -> dict:
    """Return k8s deployment detail for a RemoteApp."""
    from porpulsion import state
    from porpulsion.k8s.executor import get_deployment_status
    from porpulsion.k8s.store import get_ea_cr_by_app_id, cr_to_dict
    from porpulsion.models import RemoteApp, RemoteAppSpec

    app_id = payload.get("id", "")
    ea_cr = get_ea_cr_by_app_id(state.NAMESPACE, app_id)
    if ea_cr is None:
        raise RuntimeError("app not found")

    d = cr_to_dict(ea_cr, "executing")
    ra = RemoteApp(
        id=app_id, name=d["name"],
        spec=RemoteAppSpec.from_dict(d.get("spec", {})),
        source_peer=d["source_peer"],
    )
    result = get_deployment_status(ra)
    result["spec"] = d.get("spec", {})
    return result


def handle_remoteapp_logs(payload: dict) -> dict:
    """Return pod logs for a RemoteApp (executing on this cluster)."""
    from porpulsion import state
    from porpulsion.k8s.executor import get_pod_logs
    from porpulsion.k8s.store import get_ea_cr_by_app_id, cr_to_dict
    from porpulsion.models import RemoteApp, RemoteAppSpec

    app_id = payload.get("id", "")
    ea_cr = get_ea_cr_by_app_id(state.NAMESPACE, app_id)
    if ea_cr is None:
        raise RuntimeError("app not found")

    d = cr_to_dict(ea_cr, "executing")
    ra = RemoteApp(
        id=app_id, name=d["name"],
        spec=RemoteAppSpec.from_dict(d.get("spec", {})),
        source_peer=d["source_peer"],
    )
    tail = int(payload.get("tail") or 200)
    pod_name = (payload.get("pod") or "").strip() or None
    order_by_time = payload.get("order") == "time"
    return get_pod_logs(ra, tail=tail, pod_name=pod_name, order_by_time=order_by_time)




def handle_remoteapp_config_patch(payload: dict) -> dict:
    """Apply a key-value patch to a managed ConfigMap or Secret and trigger a rollout restart."""
    from porpulsion import state
    from porpulsion.k8s.executor import patch_configmap_data, patch_secret_data, rollout_restart
    from porpulsion.k8s.store import get_ea_cr_by_app_id, cr_to_dict, patch_cr_volume_data
    from porpulsion.models import RemoteApp, RemoteAppSpec

    app_id = payload.get("id", "")
    kind   = payload.get("kind", "")
    name   = payload.get("name", "")
    data   = payload.get("data", {})

    ea_cr = get_ea_cr_by_app_id(state.NAMESPACE, app_id)
    if ea_cr is None:
        raise RuntimeError("app not found")

    d = cr_to_dict(ea_cr, "executing")
    ra = RemoteApp(
        id=app_id, name=d["name"],
        spec=RemoteAppSpec.from_dict(d.get("spec", {})),
        source_peer=d["source_peer"],
    )
    if kind == "configmap":
        patch_configmap_data(app_id, name, data)
        patch_cr_volume_data(state.NAMESPACE, app_id, "configmap", name, data)
    elif kind == "secret":
        patch_secret_data(app_id, name, data)
        patch_cr_volume_data(state.NAMESPACE, app_id, "secret", name, data)
    else:
        raise RuntimeError(f"unknown config kind: {kind!r}")
    rollout_restart(ra)
    return {"ok": True}


def handle_remoteapp_spec_update(payload: dict) -> dict:
    """Apply a new spec to a RemoteApp on the executing side."""
    from porpulsion import state
    from porpulsion.models import RemoteAppSpec
    from porpulsion.routes.workloads import _check_resource_quota
    from porpulsion.k8s.store import get_ea_cr_by_app_id, cr_to_dict, create_executingapp_cr

    app_id   = payload.get("id", "")
    new_spec = payload.get("spec")

    ea_cr = get_ea_cr_by_app_id(state.NAMESPACE, app_id)
    if ea_cr is None:
        raise RuntimeError("app not found")

    d = cr_to_dict(ea_cr, "executing")
    parsed = RemoteAppSpec.from_dict(new_spec)
    quota_err = _check_resource_quota(parsed, source_peer=d["source_peer"])
    if quota_err:
        raise RuntimeError(quota_err)
    try:
        from porpulsion.k8s.store import validate_remoteapp_spec
        val_err = validate_remoteapp_spec(state.NAMESPACE, app_id, d["name"], parsed.to_dict(), d["source_peer"])
        if val_err:
            raise RuntimeError(f"spec invalid: {val_err}")
    except RuntimeError:
        raise
    except Exception as _ve:
        log.debug("CRD spec validation skipped: %s", _ve)

    # Update the ExecutingApp CR - the CR watcher drives the re-deploy
    create_executingapp_cr(state.NAMESPACE, app_id, d["name"], parsed.to_dict(), d["source_peer"])
    return {"ok": True}


# -- Proxy tunnel

def handle_proxy_request(payload: dict, peer_name: str = "") -> dict:
    """
    Proxy an HTTP request to a local pod and return the response.
    Body is base64-encoded in the payload.
    """
    from porpulsion import state
    from porpulsion.k8s.tunnel import proxy_request
    from porpulsion.k8s.store import get_ea_cr_by_app_id

    app_id  = payload.get("app_id", "")
    port    = int(payload.get("port", 80))
    method  = payload.get("method", "GET")
    path    = payload.get("path", "")
    headers = payload.get("headers", {})
    body    = base64.b64decode(payload.get("body", ""))

    agent = state.AGENT_NAME or "remote agent"
    denied = not state.settings.allow_inbound_tunnels
    if not denied:
        allowed_raw = (state.settings.allowed_tunnel_peers or "").strip()
        if allowed_raw:
            if allowed_raw == "__none__":
                denied = True
            else:
                allowed_tokens = {t.strip() for t in allowed_raw.split(",") if t.strip()}
                denied = peer_name not in allowed_tokens
    if denied:
        raise RuntimeError(f"'{agent}' has disabled inbound tunnels")

    if get_ea_cr_by_app_id(state.NAMESPACE, app_id) is None:
        raise RuntimeError("app not found")

    status, resp_headers, resp_body = proxy_request(
        remote_app_id=app_id, port=port,
        method=method, path=path,
        headers=headers, body=body,
    )
    return {
        "status": status,
        "headers": dict(resp_headers),
        "body": base64.b64encode(resp_body).decode(),
    }


# -- Peer lifecycle

def handle_peer_bidirectional(payload: dict):
    """The accepting peer is telling us they connected our inbound.
    Upgrade our direction to bidirectional and record the remote_addr they saw us from."""
    from porpulsion import state, tls

    peer_name   = payload.get("name", "")
    remote_addr = payload.get("remote_addr", "")
    if not peer_name:
        return
    peer = state.peers.get(peer_name)
    if peer and peer.direction == "outgoing":
        peer.direction = "bidirectional"
        tls.save_peers(state.NAMESPACE, state.peers)
        log.info("Peer %s confirmed bidirectional connection", peer_name)
    # Store on the live channel so the dashboard can show our outbound IP as seen by the peer
    ch = state.peer_channels.get(peer_name)
    if ch and remote_addr and not ch.peer_remote_addr:
        ch.peer_remote_addr = remote_addr


def handle_peer_disconnect(payload: dict):
    """Peer is telling us it's disconnecting. If reason='removed', they intentionally
    removed us  - wipe them from our state too. Otherwise keep them for reconnect."""
    from porpulsion import state, tls
    from porpulsion.notifications import add_notification
    from porpulsion.k8s.store import (
        list_remoteapp_crs, list_executingapp_crs, cr_to_dict,
        update_remoteapp_cr_status, delete_remoteapp_cr, delete_executingapp_cr,
    )

    peer_name = payload.get("name", "")
    reason    = payload.get("reason", "")
    if not peer_name or peer_name not in state.peers:
        return

    intentional_removal = (reason == "removed")

    if intentional_removal:
        # They deleted us  - remove completely from both sides
        state.peers.pop(peer_name, None)
        tls.save_peers(state.NAMESPACE, state.peers)

        # Delete RemoteApp CRs we submitted to them
        for cr in list_remoteapp_crs(state.NAMESPACE):
            d = cr_to_dict(cr, "submitted")
            if d["target_peer"] == peer_name:
                try:
                    delete_remoteapp_cr(state.NAMESPACE, d["cr_name"])
                except Exception as e:
                    log.debug("Could not delete RemoteApp CR %s: %s", d["cr_name"], e)

        # Delete ExecutingApp CRs we're running for them
        for cr in list_executingapp_crs(state.NAMESPACE):
            d = cr_to_dict(cr, "executing")
            if d["source_peer"] == peer_name:
                try:
                    delete_executingapp_cr(state.NAMESPACE, d["cr_name"])
                except Exception as e:
                    log.debug("Could not delete ExecutingApp CR %s: %s", d["cr_name"], e)

        log.info("Peer %s removed us  - wiped from state and storage", peer_name)
        add_notification(level="warn", title=f"Peer removed: {peer_name}",
                         message=f"Peer {peer_name!r} removed this agent. The peering has been torn down on both sides.")
    else:
        # Transient disconnect  - keep for reconnect
        affected = []
        for cr in list_remoteapp_crs(state.NAMESPACE):
            d = cr_to_dict(cr, "submitted")
            if d["target_peer"] == peer_name:
                try:
                    update_remoteapp_cr_status(state.NAMESPACE, d["cr_name"], "Failed", d["id"],
                                               message=f"Peer {peer_name!r} disconnected")
                except Exception as e:
                    log.debug("Could not update CR status for %s: %s", d["id"], e)
                affected.append(d["name"])

        log.info("Peer %s disconnected (via channel)  kept in peer list for reconnect", peer_name)
        msg = f"Peer {peer_name!r} disconnected."
        if affected:
            msg += f" {len(affected)} workload(s) marked Failed: {', '.join(affected[:3])}{'...' if len(affected) > 3 else ''}."
        add_notification(level="warn", title=f"Peer disconnected: {peer_name}", message=msg)

    # Remove the channel entry and tear it down.
    # For intentional removals: full close (sets _running=False, kills reconnect loop).
    # For transient disconnects: disconnect only (clears _ws so connect_and_maintain
    # will reconnect naturally without terminating the daemon thread).
    with state.peer_channels_lock:
        ch = state.peer_channels.pop(peer_name, None)
    if ch:
        if intentional_removal:
            ch.close()
        else:
            ch.disconnect()


# -- Registry pull-through proxy (submitting side)
#
# These handlers run on the *submitting* side when the executing peer's OCI
# proxy asks for image data. The submitting agent fetches from the real registry
# using locally-stored docker-registry credentials and returns the data over WS.

def _load_dockerconfig(secret_name: str) -> dict:
    """Read a kubernetes.io/dockerconfigjson Secret and return the auths dict."""
    import json as _json
    from kubernetes import client as _k8s, config as _kube_config
    from porpulsion import state
    try:
        _kube_config.load_incluster_config()
    except Exception:
        _kube_config.load_kube_config()
    core = _k8s.CoreV1Api()
    secret = core.read_namespaced_secret(secret_name, state.NAMESPACE)
    raw = (secret.data or {}).get(".dockerconfigjson", "")
    if not raw:
        return {}
    cfg = _json.loads(base64.b64decode(raw))
    return cfg.get("auths", {})


def _registry_auth_for(auths: dict, registry: str):
    """Return (username, password) for the given registry host, or (None, None)."""
    for host, creds in auths.items():
        # Normalise docker.io → index.docker.io
        normalised = host.replace("https://", "").rstrip("/")
        if normalised == registry or normalised == f"index.{registry}":
            if "auth" in creds:
                decoded = base64.b64decode(creds["auth"]).decode()
                user, _, pwd = decoded.partition(":")
                return user, pwd
            return creds.get("username"), creds.get("password")
    return None, None


def _registry_request(method: str, url: str, username=None, password=None,
                       headers: dict | None = None, stream: bool = False):
    """Make an authenticated request to a registry."""
    import urllib.request as _req
    import urllib.error as _err

    req_headers = dict(headers or {})
    if username and password:
        import base64 as _b64
        token = _b64.b64encode(f"{username}:{password}".encode()).decode()
        req_headers["Authorization"] = f"Basic {token}"

    request = _req.Request(url, headers=req_headers, method=method)
    try:
        resp = _req.urlopen(request, timeout=60)
        return resp
    except _err.HTTPError as e:
        # Docker Hub uses 401 with WWW-Authenticate for token auth — handle it
        if e.code == 401:
            www_auth = e.headers.get("WWW-Authenticate", "")
            if www_auth.startswith("Bearer "):
                token = _fetch_bearer_token(www_auth, username, password)
                if token:
                    request2 = _req.Request(url, headers={**req_headers,
                                            "Authorization": f"Bearer {token}"}, method=method)
                    return _req.urlopen(request2, timeout=60)
        raise


def _fetch_bearer_token(www_auth: str, username=None, password=None) -> str | None:
    """Fetch a Docker Bearer token from the WWW-Authenticate challenge."""
    import re
    import urllib.request as _req
    import urllib.parse as _parse

    realm = re.search(r'realm="([^"]+)"', www_auth)
    service = re.search(r'service="([^"]+)"', www_auth)
    scope = re.search(r'scope="([^"]+)"', www_auth)
    if not realm:
        return None

    params = {}
    if service:
        params["service"] = service.group(1)
    if scope:
        params["scope"] = scope.group(1)

    token_url = realm.group(1)
    if params:
        token_url += "?" + _parse.urlencode(params)

    headers = {}
    if username and password:
        import base64 as _b64
        cred = _b64.b64encode(f"{username}:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {cred}"

    try:
        import json as _json
        resp = _req.urlopen(_req.Request(token_url, headers=headers), timeout=30)
        data = _json.loads(resp.read())
        return data.get("token") or data.get("access_token")
    except Exception:
        return None


def handle_registry_manifest(payload: dict, peer_name: str = "") -> dict:
    """
    Fetch a manifest from the real registry on behalf of the executing peer.
    Returns {"manifest": "<base64>", "content_type": "...", "digest": "..."}.
    """
    image      = payload.get("image", "")
    ref        = payload.get("ref", "")
    secret_name = payload.get("registry_secret", "")

    # Parse registry host from image name
    # e.g. "registry.example.com/myapp" → host="registry.example.com", path="myapp"
    # "myapp:latest" → host="index.docker.io", path="library/myapp"
    parts = image.split("/", 1)
    if "." in parts[0] or ":" in parts[0] or parts[0] == "localhost":
        registry_host = parts[0]
        image_path    = parts[1] if len(parts) > 1 else ""
    else:
        registry_host = "index.docker.io"
        image_path    = f"library/{image}" if "/" not in image else image

    username, password = None, None
    if secret_name:
        try:
            auths = _load_dockerconfig(secret_name)
            username, password = _registry_auth_for(auths, registry_host)
        except Exception as exc:
            log.warning("registry-manifest: could not load secret %s: %s", secret_name, exc)

    scheme = "https"
    if registry_host.startswith("localhost") or registry_host.startswith("127."):
        scheme = "http"

    url = f"{scheme}://{registry_host}/v2/{image_path}/manifests/{ref}"
    accept = (
        "application/vnd.docker.distribution.manifest.v2+json,"
        "application/vnd.oci.image.manifest.v1+json,"
        "application/vnd.docker.distribution.manifest.list.v2+json,"
        "application/vnd.oci.image.index.v1+json"
    )
    try:
        resp = _registry_request("GET", url, username, password,
                                 headers={"Accept": accept})
        body = resp.read()
        ct   = resp.headers.get("Content-Type", "application/vnd.docker.distribution.manifest.v2+json")
        digest = resp.headers.get("Docker-Content-Digest", "")
        return {
            "manifest":     base64.b64encode(body).decode(),
            "content_type": ct,
            "digest":       digest,
        }
    except Exception as exc:
        log.warning("registry-manifest: fetch failed for %s:%s: %s", image, ref, exc)
        raise RuntimeError(f"manifest fetch failed: {exc}") from exc


def handle_registry_blob(payload: dict, peer_name: str = "") -> dict:
    """
    Stream a blob from the real registry back to the executing peer in chunks.

    Returns metadata immediately; blob data is pushed as registry/blob-chunk
    messages over the WS channel, with a final chunk where done=True.
    """
    import threading as _threading
    image        = payload.get("image", "")
    digest       = payload.get("digest", "")
    transfer_id  = payload.get("transfer_id", "")
    secret_name  = payload.get("registry_secret", "")

    parts = image.split("/", 1)
    if "." in parts[0] or ":" in parts[0] or parts[0] == "localhost":
        registry_host = parts[0]
        image_path    = parts[1] if len(parts) > 1 else ""
    else:
        registry_host = "index.docker.io"
        image_path    = f"library/{image}" if "/" not in image else image

    username, password = None, None
    if secret_name:
        try:
            auths = _load_dockerconfig(secret_name)
            username, password = _registry_auth_for(auths, registry_host)
        except Exception as exc:
            log.warning("registry-blob: could not load secret %s: %s", secret_name, exc)

    scheme = "https"
    if registry_host.startswith("localhost") or registry_host.startswith("127."):
        scheme = "http"

    url = f"{scheme}://{registry_host}/v2/{image_path}/blobs/{digest}"

    # Do a HEAD first to get content-length
    try:
        head_resp = _registry_request("HEAD", url, username, password)
        total_size   = int(head_resp.headers.get("Content-Length", 0))
        content_type = head_resp.headers.get("Content-Type", "application/octet-stream")
    except Exception as exc:
        raise RuntimeError(f"blob HEAD failed: {exc}") from exc

    def _stream():
        from porpulsion import state
        try:
            ch = state.peer_channels.get(peer_name)
            if ch is None:
                log.warning("registry-blob: channel to %s gone before stream started", peer_name)
                return
            resp = _registry_request("GET", url, username, password)
            seq = 0
            CHUNK = 512 * 1024  # 512 KB
            while True:
                chunk = resp.read(CHUNK)
                done = len(chunk) < CHUNK
                ch.push("registry/blob-chunk", {
                    "transfer_id": transfer_id,
                    "seq":         seq,
                    "data":        base64.b64encode(chunk).decode() if chunk else "",
                    "done":        done or not chunk,
                })
                seq += 1
                if done or not chunk:
                    break
        except Exception as exc:
            log.warning("registry-blob: stream error for transfer %s: %s", transfer_id, exc)
            try:
                ch = state.peer_channels.get(peer_name)
                if ch:
                    ch.push("registry/blob-chunk", {
                        "transfer_id": transfer_id,
                        "seq":         -1,
                        "data":        "",
                        "done":        True,
                        "error":       str(exc),
                    })
            except Exception:
                pass

    _threading.Thread(target=_stream, daemon=True,
                      name=f"reg-blob-{transfer_id[:8]}").start()

    return {
        "size":         total_size,
        "content_type": content_type,
        "digest":       digest,
    }


def handle_registry_blob_chunk(payload: dict):
    """
    Push handler on the *executing* side: a chunk of a blob arrived from
    the submitting peer. Deliver it to the waiting OCI proxy transfer queue.
    """
    from porpulsion.k8s.registry_proxy import deliver_blob_chunk
    deliver_blob_chunk(
        transfer_id=payload.get("transfer_id", ""),
        seq=payload.get("seq", 0),
        data_b64=payload.get("data", ""),
        done=payload.get("done", False),
        error=payload.get("error", ""),
    )
