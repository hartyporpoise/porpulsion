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

    spec_dict = spec.to_dict()

    # Create ExecutingApp CR - the CR watcher drives workload execution from here
    cr_name = create_executingapp_cr(
        state.NAMESPACE, app_id, payload["name"], spec_dict, source_peer,
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


def handle_remoteapp_pods(payload: dict) -> dict:
    """Return list of running pods for a RemoteApp (executing on this cluster)."""
    from porpulsion import state
    from porpulsion.k8s.executor import list_pods
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
    return list_pods(ra)


def handle_remoteapp_exec(payload: dict) -> dict:
    """Run a command in a pod for a RemoteApp (executing on this cluster)."""
    from porpulsion import state
    from porpulsion.k8s.executor import exec_in_pod
    from porpulsion.k8s.store import get_ea_cr_by_app_id, cr_to_dict
    from porpulsion.models import RemoteApp, RemoteAppSpec

    app_id = payload.get("id", "")
    pod_name = (payload.get("pod") or "").strip()
    command = (payload.get("command") or "").strip()

    ea_cr = get_ea_cr_by_app_id(state.NAMESPACE, app_id)
    if ea_cr is None:
        raise RuntimeError("app not found")

    d = cr_to_dict(ea_cr, "executing")
    ra = RemoteApp(
        id=app_id, name=d["name"],
        spec=RemoteAppSpec.from_dict(d.get("spec", {})),
        source_peer=d["source_peer"],
    )
    return exec_in_pod(ra, pod_name, command)


def handle_remoteapp_exec_open(payload: dict, ch) -> dict:
    """
    Open a PTY shell session in a pod (executing side).
    Streams stdout back to the submitted side via push("remoteapp/exec-stdout").
    Returns {session_id}.
    """
    from porpulsion import state
    from porpulsion.k8s.executor import exec_open_session
    from porpulsion.k8s.store import get_ea_cr_by_app_id, cr_to_dict
    from porpulsion.models import RemoteApp, RemoteAppSpec

    app_id = payload.get("id", "")
    pod_name = (payload.get("pod") or "").strip()
    shell = (payload.get("shell") or "/bin/sh").strip()
    # Submitted side pre-generates the session_id and registers its queue
    # before sending this RPC — use that ID so stdout pushes are routed
    # correctly even if they arrive before the .call() returns.
    session_id = (payload.get("session_id") or "").strip()

    ea_cr = get_ea_cr_by_app_id(state.NAMESPACE, app_id)
    if ea_cr is None:
        raise RuntimeError("app not found")

    d = cr_to_dict(ea_cr, "executing")
    ra = RemoteApp(
        id=app_id, name=d["name"],
        spec=RemoteAppSpec.from_dict(d.get("spec", {})),
        source_peer=d["source_peer"],
    )

    def _on_stdout(data):
        ch.push("remoteapp/exec-stdout", {"id": app_id, "session_id": session_id, "data": data})

    exec_open_session(ra, pod_name, _on_stdout, shell=shell, session_id=session_id)
    return {"session_id": session_id}


def handle_remoteapp_exec_stdin(payload: dict) -> dict:
    """Forward stdin data to a running exec session (executing side)."""
    from porpulsion.k8s.executor import exec_send_stdin

    session_id = payload.get("session_id", "")
    data = payload.get("data", "")
    exec_send_stdin(session_id, data)
    return {}


def handle_remoteapp_exec_resize(payload: dict) -> dict:
    """Forward a PTY resize event to a running exec session (executing side)."""
    from porpulsion.k8s.executor import exec_resize_session

    session_id = payload.get("session_id", "")
    cols = int(payload.get("cols", 80))
    rows = int(payload.get("rows", 24))
    exec_resize_session(session_id, cols, rows)
    return {}


def handle_remoteapp_exec_close(payload: dict) -> dict:
    """Close a running exec session (executing side)."""
    from porpulsion.k8s.executor import exec_close_session

    session_id = payload.get("session_id", "")
    exec_close_session(session_id)
    return {}


# Registry of browser-side queues waiting for exec stdout pushes.
# Keyed by (app_id, session_id) so old-session EOF cannot poison a new session.
_exec_stdout_queues: dict[tuple, object] = {}
_exec_stdout_lock = __import__("threading").Lock()


def register_exec_stdout_queue(app_id: str, session_id: str, q):
    with _exec_stdout_lock:
        _exec_stdout_queues[(app_id, session_id)] = q


def unregister_exec_stdout_queue(app_id: str, session_id: str):
    with _exec_stdout_lock:
        _exec_stdout_queues.pop((app_id, session_id), None)


def handle_remoteapp_exec_stdout(payload: dict):
    """Receive stdout push from executing peer and route to waiting browser WS."""
    app_id = payload.get("id", "")
    session_id = payload.get("session_id", "")
    data = payload.get("data")
    with _exec_stdout_lock:
        q = _exec_stdout_queues.get((app_id, session_id))
    if q is not None:
        q.put(data)  # None signals EOF


def handle_remoteapp_restart(payload: dict) -> dict:
    """Trigger a rollout restart for a RemoteApp (executing on this cluster)."""
    from porpulsion import state
    from porpulsion.k8s.executor import rollout_restart
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
        resource_name=d.get("resource_name", ""),
    )
    rollout_restart(ra)
    return {"ok": True}


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
        resource_name=d.get("resource_name", ""),
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
    from porpulsion.k8s.store import get_ea_cr_by_app_id, cr_to_dict, patch_executingapp_spec

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
        val_err = validate_remoteapp_spec(state.NAMESPACE, app_id, d["cr_name"], parsed.to_dict(), d["source_peer"])
        if val_err:
            raise RuntimeError(f"spec invalid: {val_err}")
    except RuntimeError:
        raise
    except Exception as _ve:
        log.debug("CRD spec validation skipped: %s", _ve)

    # Patch the spec on the existing EA CR directly — the CR watcher drives the re-deploy.
    # Do NOT call create_executingapp_cr here: it recomputes the name from app_name which
    # would be d["cr_name"] (already ea-{id}-{name}), producing a doubly-prefixed new CR.
    patch_executingapp_spec(state.NAMESPACE, d["cr_name"], parsed.to_dict())
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


# -- Image proxy tunnel

def handle_image_proxy_request(payload: dict) -> dict:
    """
    Proxy an OCI Distribution API request to the upstream registry on behalf of
    the executing peer.  Called on the *submitting* side, which has network access
    to the private registry.

    Payload:
      method  - HTTP method (GET, HEAD)
      url     - full upstream URL (https://registry/v2/...)
      headers - dict of headers to forward (Accept, Range, ...)
    Reply:
      status  - HTTP status int
      headers - response header dict
      body    - base64-encoded response body
    """
    import base64
    import ssl
    import urllib.error
    import urllib.request

    from porpulsion import state
    if not state.settings.registry_pull_enabled:
        raise RuntimeError("image proxy is not enabled on this agent")

    method  = payload.get("method", "GET")
    url     = payload.get("url", "")
    headers = payload.get("headers", {})

    if not url.startswith("https://"):
        raise RuntimeError("image-proxy: only https upstream URLs are supported")

    req = urllib.request.Request(url, method=method)
    for k, v in headers.items():
        req.add_header(k, v)
    req.add_unredirected_header("Accept-Encoding", "identity")

    _STRIP = {"transfer-encoding", "connection", "content-length"}
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
            data = resp.read()
            resp_headers = {k: v for k, v in resp.headers.items()
                            if k.lower() not in _STRIP}
            if "Content-Length" in resp.headers:
                resp_headers["Content-Length"] = resp.headers["Content-Length"]
            return {
                "status": resp.status,
                "headers": resp_headers,
                "body": base64.b64encode(data).decode(),
            }
    except urllib.error.HTTPError as exc:
        data = exc.read()
        resp_headers = {k: v for k, v in exc.headers.items()
                        if k.lower() not in _STRIP}
        return {
            "status": exc.code,
            "headers": resp_headers,
            "body": base64.b64encode(data).decode(),
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


def handle_peer_info_update(payload: dict):
    """Peer is pushing updated info (e.g. registry_proxy_url or api_url changed)."""
    from porpulsion import state, tls

    peer_name          = payload.get("name", "")
    registry_proxy_url = payload.get("registry_proxy_url", "")
    api_url            = payload.get("api_url", "")
    if not peer_name:
        return
    peer = state.peers.get(peer_name)
    if not peer:
        return
    changed = False
    if peer.registry_proxy_url != registry_proxy_url:
        peer.registry_proxy_url = registry_proxy_url
        changed = True
        log.info("Peer %s updated registry_proxy_url: %r", peer_name, registry_proxy_url)
    if api_url and peer.api_url != api_url:
        peer.api_url = api_url
        changed = True
        log.info("Peer %s updated api_url: %r", peer_name, api_url)
    if changed:
        tls.save_peers(state.NAMESPACE, state.peers)


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

