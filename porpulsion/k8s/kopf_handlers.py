"""
Kopf operator handlers for ExecutingApp and RemoteApp CRs.

ExecutingApp (executing side):
  - create/update -> run_workload() with owner refs so k8s GC cleans up children
  - delete -> cancel polling loop + notify source peer (children GC'd automatically)

RemoteApp (submitted side):
  - create -> forward remoteapp/receive to target peer
  - update -> forward remoteapp/spec-update to target peer
  - delete -> send remoteapp/delete to target peer

The finalizer on ExecutingApp CRs ensures cleanup always runs, even on
kubectl delete, before the CR is actually removed from the API.
"""
import logging

import kopf

from porpulsion.k8s.store import (
    GROUP, VERSION, PLURAL_EA, PLURAL,
    bootstrap_cr_status, _patch_status,
)

log = logging.getLogger("porpulsion.kopf")


# -- ExecutingApp handlers

@kopf.on.create(GROUP, VERSION, "executingapps")
def on_executingapp_created(body, meta, status, namespace, **kwargs):
    """Create k8s workload resources for a new ExecutingApp CR."""
    _run_executingapp(body, meta, status, namespace)


@kopf.on.update(GROUP, VERSION, "executingapps", field="spec")
def on_executingapp_spec_updated(body, meta, status, namespace, **kwargs):
    """Update k8s workload resources when an ExecutingApp spec changes."""
    _run_executingapp(body, meta, status, namespace)


def _run_executingapp(body, meta, status, namespace):
    from porpulsion.k8s.executor import run_workload
    from porpulsion.models import RemoteApp, RemoteAppSpec

    cr_name = meta["name"]

    app_id = status.get("appId", "")
    if not app_id:
        app_id = bootstrap_cr_status(namespace, PLURAL_EA, cr_name, dict(status))
    if not app_id:
        raise kopf.TemporaryError("appId not set in status yet", delay=1)

    spec_dict = dict(body.get("spec", {}))
    source_peer = status.get("sourcePeer", "")
    resource_name = status.get("resourceName", "")

    spec = RemoteAppSpec.from_dict(spec_dict)
    ra = RemoteApp(
        id=app_id,
        name=cr_name,
        spec=spec,
        source_peer=source_peer,
        resource_name=resource_name,
    )
    ra.cr_name = cr_name

    log.info("kopf: ExecutingApp %s (%s) changed - running workload", cr_name, app_id)
    run_workload(ra, source_peer, cr_body=body)


@kopf.on.delete(GROUP, VERSION, "executingapps")
def on_executingapp_deleted(body, meta, status, **kwargs):
    """Notify source peer when an ExecutingApp is deleted. Child resources are GC'd via owner references."""
    from porpulsion.k8s.executor import _stop_events

    app_id = status.get("appId", "")
    source_peer = status.get("sourcePeer", "")
    cr_name = meta["name"]

    # Cancel any in-progress deploy/poll loop
    ev = _stop_events.pop(app_id, None)
    if ev:
        ev.set()

    log.info("kopf: ExecutingApp %s (%s) deleted - notifying source peer", cr_name, app_id)

    if source_peer and app_id:
        try:
            from porpulsion.channel import get_channel
            get_channel(source_peer).push("remoteapp/status", {
                "id": app_id, "status": "Deleted",
            })
        except Exception as e:
            log.warning("kopf: failed to notify source peer %s of EA deletion: %s", source_peer, e)
    elif not source_peer:
        log.warning("kopf: EA %s deleted but sourcePeer is empty - cannot notify", app_id)


# -- RemoteApp handlers

@kopf.on.create(GROUP, VERSION, "remoteapps")
def on_remoteapp_created(body, meta, status, namespace, **kwargs):
    """Forward a new RemoteApp CR to the target peer via WS channel."""
    from porpulsion import state

    cr_name = meta["name"]
    app_id = status.get("appId", "")
    if not app_id:
        app_id = bootstrap_cr_status(namespace, PLURAL, cr_name, dict(status))
    if not app_id:
        raise kopf.TemporaryError("appId not set in status yet", delay=1)
    spec_dict = dict(body.get("spec", {}))
    target_peer = spec_dict.pop("targetPeer", "")
    if not target_peer:
        return

    peer = state.peers.get(target_peer)
    if not peer:
        log.warning("kopf: RemoteApp %s targets peer %r which is not connected", cr_name, target_peer)
        raise kopf.TemporaryError(f"peer {target_peer!r} not connected", delay=5)

    if not peer.can_deploy():
        msg = (f"Cannot deploy to '{target_peer}' — they connected to us (incoming only). "
               "Paste their invite bundle to enable bidirectional peering.")
        log.warning("kopf: RemoteApp %s rejected: %s", cr_name, msg)
        _patch_status(namespace, PLURAL, cr_name, {
            "phase": "Failed", "appId": app_id,
            "message": msg,
        })
        raise kopf.PermanentError(msg)

    payload = {
        "id": app_id,
        "name": cr_name,
        "spec": spec_dict,
        "source_peer": state.AGENT_NAME,
    }
    try:
        from porpulsion.channel import get_channel
        get_channel(peer.name).call("remoteapp/receive", payload)
        log.info("kopf: forwarded new RemoteApp %s (%s) to peer %s", cr_name, app_id, peer.name)
    except Exception as e:
        err_msg = str(e)
        # Peer explicitly rejected the workload (quota, policy, disabled) — mark Failed, don't retry
        _peer_rejection_phrases = (
            "inbound workloads are disabled",
            "Insufficient",
            "quota",
            "not permitted",
            "blocked image",
            "is blocked",
            "allowed image list",
            "spec invalid",
            "not allowed",
            "cluster's policy",
        )
        if any(p in err_msg for p in _peer_rejection_phrases):
            log.warning("kopf: RemoteApp %s rejected by peer %s: %s", cr_name, target_peer, err_msg)
            _patch_status(namespace, PLURAL, cr_name, {
                "phase": "Failed", "appId": app_id,
                "message": f"Rejected by {target_peer}: {err_msg}",
            })
            # Push status back to own channel_handlers so the UI updates immediately
            try:
                from porpulsion.channel_handlers import handle_remoteapp_status
                handle_remoteapp_status({
                    "id": app_id,
                    "status": "Failed",
                    "message": f"Rejected by {target_peer}: {err_msg}",
                })
            except Exception:
                pass
            raise kopf.PermanentError(err_msg)
        raise kopf.TemporaryError(f"failed to forward to peer {target_peer}: {err_msg}", delay=5)


@kopf.on.update(GROUP, VERSION, "remoteapps", field="spec")
def on_remoteapp_spec_updated(body, meta, status, **kwargs):
    """Forward a spec update for an existing RemoteApp to the target peer."""
    from porpulsion import state

    app_id = status.get("appId", "")
    if not app_id:
        raise kopf.TemporaryError("appId not set in status yet", delay=1)

    cr_name = meta["name"]
    spec_dict = dict(body.get("spec", {}))
    target_peer = spec_dict.pop("targetPeer", "")
    if not target_peer:
        return

    peer = state.peers.get(target_peer)
    if not peer:
        log.warning("kopf: RemoteApp %s targets peer %r which is not connected", cr_name, target_peer)
        raise kopf.TemporaryError(f"peer {target_peer!r} not connected", delay=5)

    payload = {"id": app_id, "spec": spec_dict, "source_peer": state.AGENT_NAME}
    try:
        from porpulsion.channel import get_channel
        get_channel(peer.name).call("remoteapp/spec-update", payload)
        log.info("kopf: forwarded spec update for RemoteApp %s (%s) to peer %s", cr_name, app_id, peer.name)
    except Exception as e:
        raise kopf.TemporaryError(f"failed to forward spec update to peer {target_peer}: {e}", delay=5)


@kopf.on.delete(GROUP, VERSION, "remoteapps")
def on_remoteapp_deleted(body, meta, status, **kwargs):
    """Tell the executing peer to delete its ExecutingApp CR."""
    from porpulsion import state

    app_id = status.get("appId", "")
    cr_name = meta["name"]
    spec_dict = dict(body.get("spec", {}))
    target_peer = spec_dict.get("targetPeer", "")
    if not target_peer or not app_id:
        return

    peer = state.peers.get(target_peer)
    if not peer:
        # Peer removed entirely - nothing to notify; let the CR delete proceed
        log.warning("kopf: RemoteApp %s deleted but peer %r unknown - cannot notify", cr_name, target_peer)
        return

    # If the RA status is already Deleted the EA was already cleaned up on the peer
    if status.get("status") == "Deleted":
        log.info("kopf: RemoteApp %s already Deleted - skipping peer notification", cr_name)
        return

    try:
        from porpulsion.channel import get_channel
        get_channel(peer.name).call("remoteapp/delete", {"id": app_id})
        log.info("kopf: notified peer %s to delete EA for RemoteApp %s (%s)", peer.name, cr_name, app_id)
    except Exception as e:
        # Any failure (channel down etc.) — retry so the delete reaches them when reconnected
        raise kopf.TemporaryError(f"failed to notify peer {target_peer} of RA deletion: {e}", delay=10)
