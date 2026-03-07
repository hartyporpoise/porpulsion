import logging
import secrets
import uuid
from datetime import datetime, timezone

import requests as _req
import urllib3 as _urllib3
from flask import Blueprint, request, jsonify

from porpulsion import state, tls
from porpulsion.models import Peer
from porpulsion.peering import initiate_peering
from porpulsion.channel import open_channel_to

log = logging.getLogger("porpulsion.routes.peers")

bp = Blueprint("peers", __name__)


@bp.route("/peers")
def list_peers():
    result = []
    for p in state.peers.values():
        d = p.to_dict()
        ch = state.peer_channels.get(p.name)
        d["channel"] = "connected" if (ch and ch.is_connected()) else "disconnected"
        if ch and ch.latency_ms is not None:
            d["latency_ms"] = round(ch.latency_ms, 1)
        result.append(d)
    for url, info in state.pending_peers.items():
        entry = {
            "name": info.get("name", url),
            "url": url,
            "connected_at": info["since"],
            "status": info.get("status", "connecting"),
            "attempts": info["attempts"],
        }
        if "error" in info:
            entry["error"] = info["error"]
        result.append(entry)
    return jsonify(result)


@bp.route("/peer", methods=["POST"])
def accept_peer():
    """
    Peering endpoint  two steps:

    Step 1 (invite): initiator sends our invite token + their cert.
    Step 2 (confirm): called by accept_inbound() when operator clicks Accept.
    """
    data = request.json
    if not isinstance(data, dict):
        return jsonify({"error": "request body must be a JSON object"}), 400
    peer_name = data.get("name", "unknown")
    peer_url  = data.get("url", "")
    peer_ca   = data.get("ca", "")

    presented_token = request.headers.get("X-Invite-Token", "")

    # -- Confirmation path (no token, ca in body)
    if peer_ca and not presented_token:
        presented_fp = tls.cert_fingerprint(peer_ca)
        log.info("Confirmation from %s (url=%r), presented_fp=%s, pending keys=%s",
                 peer_name, peer_url, presented_fp[:16], list(state.pending_peers.keys()))
        awaiting = state.pending_peers.get(peer_url)
        if not awaiting:
            for _url, _info in state.pending_peers.items():
                if _info.get("status") == "awaiting_confirmation":
                    stored = _info.get("ca_pem", "")
                    stored_fp = tls.cert_fingerprint(stored) if stored else "(empty)"
                    if stored and stored_fp == presented_fp:
                        awaiting = _info
                        peer_url = _url
                        break
        if awaiting and awaiting.get("status") == "awaiting_confirmation":
            tls.write_temp_pem(peer_ca.encode(), f"peer-ca-{peer_name}")
            state.peers[peer_name] = Peer(name=peer_name, url=peer_url, ca_pem=peer_ca)
            state.pending_peers.pop(peer_url, None)
            tls.save_peers(state.NAMESPACE, state.peers)
            log.info("Peering confirmed by %s  fully connected", peer_name)
            # We are the initiator  open outbound WS channel to the accepting peer
            open_channel_to(peer_name, peer_url, ca_pem=peer_ca)
            return jsonify({"name": state.AGENT_NAME, "status": "peered",
                            "ca": state.AGENT_CA_PEM.decode()})
        log.warning("accept_peer: unexpected ca-only request from %s (no matching pending)", peer_name)
        return jsonify({"error": "no pending outbound connection for this peer"}), 403

    # -- Invite path
    if not presented_token or not secrets.compare_digest(presented_token, state.invite_token):
        log.warning("accept_peer: bad or missing invite token from %s", request.remote_addr)
        return jsonify({"error": "invalid token"}), 403

    state.invite_token = secrets.token_hex(32)
    tls.persist_token(state.NAMESPACE, state.invite_token)
    log.info("Invite token consumed  queuing inbound request from %s", peer_name)

    req_id = uuid.uuid4().hex[:12]
    state.pending_inbound[req_id] = {
        "id": req_id,
        "name": peer_name,
        "url": peer_url,
        "ca_pem": peer_ca,
        "since": datetime.now(timezone.utc).isoformat(),
    }
    if peer_ca:
        tls.write_temp_pem(peer_ca.encode(), f"peer-ca-{peer_name}")

    return jsonify({"name": state.AGENT_NAME, "status": "pending",
                    "ca": state.AGENT_CA_PEM.decode()})


@bp.route("/peers/inbound", methods=["GET"])
def list_inbound():
    _hide = {"ca_pem"}
    return jsonify([{"id": req_id, **{k: v for k, v in r.items() if k not in _hide}}
                    for req_id, r in state.pending_inbound.items()])


@bp.route("/peers/inbound/<req_id>/accept", methods=["POST"])
def accept_inbound(req_id):
    if req_id not in state.pending_inbound:
        return jsonify({"error": "request not found"}), 404

    info = state.pending_inbound.pop(req_id)
    peer_name = info["name"]
    peer_url  = info["url"]
    peer_ca   = info.get("ca_pem", "")

    _urllib3.disable_warnings(_urllib3.exceptions.InsecureRequestWarning)
    session = _req.Session()
    session.verify = False  # no CA pinned yet at this stage  bootstrap trust

    try:
        resp = session.post(
            f"{peer_url}/peer",
            json={"name": state.AGENT_NAME, "url": state.SELF_URL,
                  "ca": state.AGENT_CA_PEM.decode()},
            timeout=5,
        )
        if resp.status_code == 200:
            resp_data = resp.json()
            their_ca = resp_data.get("ca", peer_ca)
            tls.write_temp_pem(their_ca.encode() if isinstance(their_ca, str) else their_ca,
                               f"peer-ca-{peer_name}")
            state.peers[peer_name] = Peer(name=peer_name, url=peer_url, ca_pem=their_ca)
            tls.save_peers(state.NAMESPACE, state.peers)
            log.info("Accepted and confirmed peering with %s", peer_name)
            # We are the acceptor  the initiator will open the WS channel to us,
            # so we don't need to connect outbound here.
            return jsonify({"ok": True, "peer": peer_name})
        log.warning("accept_inbound: initiator returned %s: %s", resp.status_code, resp.text[:200])
        state.pending_inbound[req_id] = info
        return jsonify({"error": f"initiator returned {resp.status_code}"}), 502
    except Exception as exc:
        log.warning("accept_inbound: could not reach %s: %s", peer_url, exc)
        state.pending_inbound[req_id] = info
        return jsonify({"error": str(exc)}), 502


@bp.route("/peers/inbound/<req_id>", methods=["DELETE"])
def reject_inbound(req_id):
    if req_id not in state.pending_inbound:
        return jsonify({"error": "request not found"}), 404
    info = state.pending_inbound.pop(req_id)
    log.info("Rejected inbound peering request from %s", info["name"])
    return jsonify({"ok": True})


@bp.route("/peers/<peer_name>", methods=["DELETE"])
def remove_peer(peer_name):
    if peer_name not in state.peers:
        return jsonify({"error": "peer not found"}), 404

    from porpulsion.channel import get_channel
    from porpulsion.k8s.store import (
        list_remoteapp_crs, list_executingapp_crs, delete_remoteapp_cr,
        delete_executingapp_cr, cr_to_dict,
    )
    # -- 1. Delete RemoteApp CRs we submitted to this peer
    for cr in list_remoteapp_crs(state.NAMESPACE):
        d = cr_to_dict(cr, "submitted")
        if d["target_peer"] == peer_name:
            try:
                get_channel(peer_name, wait=2.0).call("remoteapp/delete", {"id": d["id"]})
            except Exception as exc:
                log.debug("Could not notify %s to delete app %s: %s", peer_name, d["id"], exc)
            delete_remoteapp_cr(state.NAMESPACE, d["cr_name"])
            log.info("Deleted RemoteApp CR %s (peer %s removed)", d["id"], peer_name)

    # -- 2. Delete ExecutingApp CRs we're running for this peer
    for cr in list_executingapp_crs(state.NAMESPACE):
        d = cr_to_dict(cr, "executing")
        if d["source_peer"] == peer_name:
            delete_executingapp_cr(state.NAMESPACE, d["cr_name"])
            log.info("Deleted ExecutingApp CR %s (peer %s removed)", d["id"], peer_name)

    tls.save_state_configmap(state.NAMESPACE, state.settings)

    # -- 3. Notify peer and close the channel
    state.peers.pop(peer_name)
    log.info("Removed peer %s", peer_name)

    try:
        get_channel(peer_name, wait=2.0).push("peer/disconnect", {"name": state.AGENT_NAME})
    except Exception as exc:
        log.debug("Could not notify %s of disconnection: %s", peer_name, exc)

    ch = state.peer_channels.pop(peer_name, None)
    if ch:
        ch.close()

    tls.save_peers(state.NAMESPACE, state.peers)
    return jsonify({"ok": True, "removed": peer_name})


@bp.route("/peer/disconnect", methods=["POST"])
def peer_disconnect():
    data = request.json
    if not isinstance(data, dict):
        data = {}
    peer_name = data.get("name", "")
    removed = False
    if peer_name and peer_name in state.peers:
        # Keep peer in state.peers (persisted) so it auto-reconnects.
        # The channel's connect_and_maintain loop retries automatically.
        state.peer_channels.pop(peer_name, None)
        removed = True
        log.info("Peer %s disconnected us  peer kept for reconnect", peer_name)
        # Mark all RemoteApp CRs targeting this peer as Failed
        from porpulsion.k8s.store import list_remoteapp_crs, cr_to_dict, update_remoteapp_cr_status
        for cr in list_remoteapp_crs(state.NAMESPACE):
            d = cr_to_dict(cr, "submitted")
            if d["target_peer"] == peer_name:
                try:
                    update_remoteapp_cr_status(state.NAMESPACE, d["cr_name"], "Failed", d["id"],
                                               message=f"Peer {peer_name!r} disconnected")
                except Exception as e:
                    log.debug("Could not update CR status for %s: %s", d["id"], e)
                log.info("Marked app %s as Failed (peer %s disconnected)", d["id"], peer_name)
    return jsonify({"ok": True, "removed": removed})


@bp.route("/peers/retry", methods=["POST"])
def retry_connecting_peer():
    data = request.json
    if not isinstance(data, dict):
        return jsonify({"error": "request body must be a JSON object"}), 400
    peer_url       = data.get("url", "")
    token          = data.get("invite_token", "")
    ca_fingerprint = data.get("ca_fingerprint", "")
    if not peer_url:
        return jsonify({"error": "url is required"}), 400
    if not token:
        return jsonify({"error": "invite_token is required to retry"}), 400
    if not ca_fingerprint:
        return jsonify({"error": "ca_fingerprint is required to retry"}), 400

    state.pending_peers[peer_url] = {
        "name": peer_url, "url": peer_url,
        "since": datetime.now(timezone.utc).isoformat(), "attempts": 0,
    }
    initiate_peering(state.AGENT_NAME, state.SELF_URL, peer_url, token,
                     state.peers, state.pending_peers,
                     ca_pem_str=state.AGENT_CA_PEM.decode(), expected_ca_fp=ca_fingerprint)
    log.info("Retrying peering with %s", peer_url)
    return jsonify({"ok": True, "message": f"Retrying connection to {peer_url}"})


@bp.route("/peers/connecting", methods=["DELETE"])
def cancel_connecting_peer():
    peer_url = request.args.get("url", "")
    if not peer_url:
        return jsonify({"error": "url query parameter required"}), 400
    if peer_url in state.pending_peers:
        del state.pending_peers[peer_url]
        log.info("Cancelled pending connection to %s", peer_url)
        return jsonify({"ok": True, "cancelled": peer_url})
    return jsonify({"error": "no pending connection to that URL"}), 404


@bp.route("/peers/connect", methods=["POST"])
def connect_peer():
    data = request.json
    if not isinstance(data, dict):
        return jsonify({"error": "request body must be a JSON object"}), 400
    url            = data.get("url", "").rstrip("/")
    token          = data.get("invite_token", "")
    ca_fingerprint = data.get("ca_fingerprint", "")
    if not url:
        return jsonify({"error": "url is required"}), 400
    if not token:
        return jsonify({"error": "invite_token is required"}), 400
    if not ca_fingerprint:
        return jsonify({"error": "ca_fingerprint is required"}), 400

    # Reject if already peered with a peer at this URL
    for existing in state.peers.values():
        if existing.url.rstrip("/") == url:
            return jsonify({"error": f"Already peered with \"{existing.name}\" at this URL"}), 409

    # Reject if the CA fingerprint matches an already-connected peer (same cluster, different URL)
    for existing in state.peers.values():
        if existing.ca_pem:
            try:
                existing_fp = tls.cert_fingerprint(existing.ca_pem)
                if existing_fp == ca_fingerprint:
                    return jsonify({"error": f"Already peered with this cluster as \"{existing.name}\""}), 409
            except Exception:
                pass

    # Reject if already attempting to connect to this URL
    if url in state.pending_peers:
        return jsonify({"error": f"Already connecting to {url}  cancel it first if you want to retry"}), 409

    state.pending_peers[url] = {
        "name": url, "url": url,
        "since": datetime.now(timezone.utc).isoformat(), "attempts": 0,
    }
    initiate_peering(state.AGENT_NAME, state.SELF_URL, url, token,
                     state.peers, state.pending_peers,
                     ca_pem_str=state.AGENT_CA_PEM.decode(), expected_ca_fp=ca_fingerprint)
    return jsonify({"ok": True, "message": f"Peering initiated with {url}"})


@bp.route("/token")
def get_token():
    fp = tls.cert_fingerprint(state.AGENT_CA_PEM)
    return jsonify({
        "agent": state.AGENT_NAME,
        "namespace": state.NAMESPACE,
        "invite_token": state.invite_token,
        "self_url": state.SELF_URL,
        "cert_fingerprint": fp,
        "ca_pem": state.AGENT_CA_PEM.decode(),
    })
