import ipaddress
import logging
import socket
import urllib.parse

from flask import Blueprint, request, jsonify

from porpulsion import state, tls
from porpulsion.models import Peer
from porpulsion.channel import open_channel_to
from porpulsion.openapi_spec import api_doc, REF_PEER_ENTRY

log = logging.getLogger("porpulsion.routes.peers")


def _is_private_ip(host: str) -> bool:
    """Return True if host resolves to (or is) a private/link-local/loopback address."""
    try:
        addr = ipaddress.ip_address(host)
        return addr.is_private or addr.is_loopback or addr.is_link_local
    except ValueError:
        pass
    # It's a hostname — resolve it
    try:
        infos = socket.getaddrinfo(host, None)
        for _, _, _, _, sockaddr in infos:
            ip = sockaddr[0]
            try:
                addr = ipaddress.ip_address(ip)
                if addr.is_private or addr.is_loopback or addr.is_link_local:
                    return True
            except ValueError:
                continue
    except OSError:
        pass
    return False


def _check_reachable(host: str, port: int, timeout: float = 3.0) -> bool:
    """Try a TCP connect to host:port. Returns True if successful."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


bp = Blueprint("peers", __name__)


@bp.route("/peers")
@api_doc("List peers", tags=["Peers"],
         description="List all connected and pending peers with channel status.",
         responses={"200": {"description": "OK", "content": {"application/json": {"schema": {"type": "array", "items": REF_PEER_ENTRY}}}}})
def list_peers():
    result = []
    for p in state.peers.values():
        d = p.to_dict()
        ch = state.peer_channels.get(p.name)
        d["channel"] = "connected" if (ch and ch.is_connected()) else "disconnected"
        if ch and ch.latency_ms is not None:
            d["latency_ms"] = round(ch.latency_ms, 1)
        if ch and ch.peer_version_hash:
            d["version_hash"] = ch.peer_version_hash
        if ch and ch.peer_remote_addr:
            d["remote_addr"] = ch.peer_remote_addr
        result.append(d)
    return jsonify(result)


@bp.route("/invite")
@api_doc("Get signed invite bundle", tags=["Peers"],
         description=(
             "Returns a signed invite bundle for this agent. The bundle is a compact base64url blob "
             "containing the agent name, URL, CA cert, and an ECDSA signature. The connecting peer "
             "verifies the signature locally before making any network call."
         ),
         responses={"200": {"description": "OK", "content": {"application/json": {"schema": {
             "type": "object",
             "properties": {
                 "agent": {"type": "string"},
                 "self_url": {"type": "string"},
                 "bundle": {"type": "string", "description": "Signed base64url invite bundle"},
                 "cert_fingerprint": {"type": "string", "description": "Human-readable only"},
             },
         }}}}})
def get_invite():
    """
    Generate and return a signed invite bundle for this agent.

    The bundle is a compact base64url blob containing the agent name, URL,
    CA cert, and an ECDSA signature over those fields using the CA private
    key.  The connecting peer verifies the signature before making any
    network call — no separate fingerprint or token needed.
    """
    bundle = tls.sign_bundle(
        agent_name=state.AGENT_NAME,
        url=state.SELF_URL,
        ca_pem=state.AGENT_CA_PEM,
        ca_key_pem=state.AGENT_CA_KEY_PEM,
    )
    fp = tls.cert_fingerprint(state.AGENT_CA_PEM)
    return jsonify({
        "agent": state.AGENT_NAME,
        "namespace": state.NAMESPACE,
        "self_url": state.SELF_URL,
        "version_hash": state.VERSION_HASH,
        "bundle": bundle,
        "cert_fingerprint": fp,   # human-readable only - not required for connect
    })


@bp.route("/peers/connect", methods=["POST"])
@api_doc("Connect to peer via invite bundle", tags=["Peers"],
         description=(
             "Initiate peering with another agent using their signed invite bundle. "
             "The bundle signature is verified locally before any network call is made."
         ),
         request_body={"required": True, "content": {"application/json": {"schema": {
             "type": "object", "required": ["bundle"],
             "properties": {"bundle": {"type": "string", "description": "Signed base64url invite bundle from /invite"}},
         }}}},
         responses={"200": {"description": "OK — WS channel connecting"},
                    "400": {"description": "Missing or invalid bundle"},
                    "409": {"description": "Already peered with this agent"}})
def connect_peer():
    """
    Initiate peering with a remote agent using their signed invite bundle.

    Body: {"bundle": "<base64url blob from their /api/invite>"}

    The bundle is verified locally (signature check) before any network call.
    The WS connect then uses the pinned CA from the bundle for TLS verification.
    Authentication completes via the peer/hello frame on the WS channel itself.
    """
    data = request.json
    if not isinstance(data, dict):
        return jsonify({"error": "request body must be a JSON object"}), 400

    bundle_b64 = (data.get("bundle") or "").strip()
    if not bundle_b64:
        return jsonify({"error": "bundle is required"}), 400

    # Verify signature before touching the network
    try:
        parsed = tls.verify_bundle(bundle_b64)
    except ValueError as exc:
        return jsonify({"error": f"invalid bundle: {exc}"}), 400

    peer_name = parsed["agent_name"]
    peer_url  = parsed["url"].rstrip("/")
    peer_ca   = parsed["ca_pem"]

    # Reachability check for private IPs — reject early rather than hanging on connect
    try:
        parsed_url = urllib.parse.urlparse(peer_url)
        host = parsed_url.hostname or ""
        default_port = 443 if parsed_url.scheme == "https" else 80
        port = parsed_url.port or default_port
        if host and _is_private_ip(host):
            if not _check_reachable(host, port, timeout=3.0):
                return jsonify({
                    "error": f"Cannot reach {host}:{port} — the peer URL resolves to a private "
                             f"address that is not reachable from this agent. Check that the URL "
                             f"is correct and the peer is online."
                }), 400
    except Exception as exc:
        log.debug("Reachability pre-check failed for %s: %s", peer_url, exc)

    # Check for existing peer entries
    for existing in state.peers.values():
        url_match = existing.url.rstrip("/") == peer_url
        ca_match = False
        if existing.ca_pem:
            try:
                ca_match = tls.cert_fingerprint(existing.ca_pem) == tls.cert_fingerprint(peer_ca)
            except Exception:
                pass
        if url_match or ca_match or existing.name == peer_name:
            if existing.direction == "bidirectional":
                return jsonify({"error": f"Already fully peered with \"{existing.name}\""}), 409
            if existing.direction == "outgoing":
                return jsonify({"error": f"Already peered with \"{existing.name}\""}), 409
            # direction == "incoming": they connected first, we're now peering back → bidirectional
            existing.direction = "bidirectional"
            existing.url = peer_url
            existing.ca_pem = peer_ca
            tls.save_peers(state.NAMESPACE, state.peers)
            log.info("Upgrading peer %s to bidirectional - opening outbound channel to %s", existing.name, peer_url)
            open_channel_to(existing.name, peer_url, ca_pem=peer_ca)
            return jsonify({"ok": True, "message": f"Connecting outbound to {existing.name} at {peer_url}"})

    tls.write_temp_pem(peer_ca.encode() if isinstance(peer_ca, str) else peer_ca,
                       f"peer-ca-{peer_name}")
    state.peers[peer_name] = Peer(name=peer_name, url=peer_url, ca_pem=peer_ca)
    tls.save_peers(state.NAMESPACE, state.peers)
    log.info("Bundle verified for %s — opening WS channel", peer_name)

    # Open outbound WS — hello frame inside the channel proves key possession
    open_channel_to(peer_name, peer_url, ca_pem=peer_ca)
    return jsonify({"ok": True, "message": f"Connecting to {peer_name} at {peer_url}"})


@bp.route("/peers/<peer_name>", methods=["DELETE"])
@api_doc("Remove peer", tags=["Peers"],
         description="Remove a peer and disconnect. Submitted apps targeting this peer are marked Failed.",
         parameters=[{"name": "peer_name", "in": "path", "required": True, "schema": {"type": "string"}}],
         responses={"200": {"description": "OK", "content": {"application/json": {"schema": {
             "type": "object", "properties": {"ok": {"type": "boolean"}, "removed": {"type": "string"}}}}}},
                    "404": {"description": "Peer not found"}})
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

    # -- 3. Persist removal first (so restart is consistent even if we crash mid-cleanup)
    state.peers.pop(peer_name)
    tls.save_peers(state.NAMESPACE, state.peers)
    log.info("Removed peer %s", peer_name)

    # -- 4. Notify peer and close the channel
    try:
        get_channel(peer_name, wait=2.0).push("peer/disconnect",
                                              {"name": state.AGENT_NAME, "reason": "removed"})
    except Exception as exc:
        log.debug("Could not notify %s of disconnection: %s", peer_name, exc)

    with state.peer_channels_lock:
        ch = state.peer_channels.pop(peer_name, None)
    if ch:
        ch.close()

    return jsonify({"ok": True, "removed": peer_name})
