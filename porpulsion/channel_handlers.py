"""
Message handlers for incoming WebSocket frames.

Each function is registered on a PeerChannel by channel._register_handlers().
Handlers for request-type messages return a dict payload (sent as the reply).
Handlers for push-type messages return None.

All inbound peer authentication has already been done by the WS endpoint
before the socket is handed to the channel — these handlers trust the caller.
"""
import base64
import logging
from datetime import datetime, timezone

log = logging.getLogger("porpulsion.channel_handlers")


# ── RemoteApp ─────────────────────────────────────────────────

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

    # Create ExecutingApp CR — the CR watcher drives workload execution from here
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
                message=f"{d['name']!r} on {d['target_peer']} → {status}.",
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
        raise RuntimeError("app not found")

    d = cr_to_dict(ea_cr, "executing")
    # Delete the CR — the CR watcher (DELETED) handles workload cleanup and peer notification
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

    # Update the ExecutingApp CR — the CR watcher drives the re-deploy
    create_executingapp_cr(state.NAMESPACE, app_id, d["name"], parsed.to_dict(), d["source_peer"])
    return {"ok": True}


# ── Proxy tunnel ──────────────────────────────────────────────

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

    if not state.settings.allow_inbound_tunnels:
        raise RuntimeError("inbound tunnels are disabled on this agent")

    allowed_raw = (state.settings.allowed_tunnel_peers or "").strip()
    if allowed_raw:
        allowed_tokens = {t.strip() for t in allowed_raw.split(",") if t.strip()}
        if peer_name not in allowed_tokens and f"{peer_name}/{app_id}" not in allowed_tokens:
            raise RuntimeError(f"tunnel from peer '{peer_name}' is not permitted")

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


# ── Peer lifecycle ────────────────────────────────────────────

def handle_peer_disconnect(payload: dict):
    """Peer is telling us it's disconnecting cleanly."""
    from porpulsion import state, tls
    from porpulsion.notifications import add_notification
    from porpulsion.k8s.store import list_remoteapp_crs, cr_to_dict, update_remoteapp_cr_status

    peer_name = payload.get("name", "")
    if peer_name and peer_name in state.peers:
        state.peers.pop(peer_name)
        state.peer_channels.pop(peer_name, None)

        # Mark all RemoteApp CRs targeting this peer as Failed
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

        tls.save_peers(state.NAMESPACE, state.peers)
        log.info("Peer %s disconnected (via channel)", peer_name)
        msg = f"Peer {peer_name!r} disconnected."
        if affected:
            msg += f" {len(affected)} workload(s) marked Failed: {', '.join(affected[:3])}{'…' if len(affected) > 3 else ''}."
        add_notification(level="warn", title=f"Peer disconnected: {peer_name}", message=msg)
