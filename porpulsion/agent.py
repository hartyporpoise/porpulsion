"""
Porpulsion agent entrypoint.

Initialises runtime config (TLS, invite token, env vars) into the shared
state module, registers Flask blueprints, and starts the HTTP server.
"""
import hashlib
import logging
import os
import pathlib
import socket
import threading

from flask import Flask, render_template, Response, jsonify

from porpulsion import state, tls
from porpulsion.log_buffer import install_log_handler
from porpulsion.routes import peers as peers_bp
from porpulsion.routes import workloads as workloads_bp
from porpulsion.routes import tunnels as tunnels_bp
from porpulsion.routes import settings as settings_bp
from porpulsion.routes import logs as logs_bp
from porpulsion.routes import notifications as notifications_bp
from porpulsion.routes import ui as ui_bp
from porpulsion.routes import auth as auth_bp

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
install_log_handler(1000)
log = logging.getLogger("porpulsion.agent")

# ── Bootstrap config ──────────────────────────────────────────

state.AGENT_NAME = os.environ.get("AGENT_NAME", "porpulsion-agent")

_self_url_env = os.environ.get("SELF_URL", "")
if _self_url_env:
    state.SELF_URL = _self_url_env
else:
    try:
        _s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        _s.connect(("8.8.8.8", 80))
        _detected_ip = _s.getsockname()[0]
        _s.close()
    except Exception:
        _detected_ip = "127.0.0.1"
    state.SELF_URL = f"http://{_detected_ip}:8000"
    log.warning(
        "SELF_URL not set — auto-detected as %s. "
        "This is a pod-internal IP and will cause peering to fail across clusters. "
        "Set agent.selfUrl in your Helm values to the externally reachable URL for "
        "this agent (e.g. https://porpulsion.example.com).",
        state.SELF_URL
    )

# Load invite token from k8s Secret (generate if absent)
state.invite_token = tls.load_or_generate_token(state.NAMESPACE)

# Load CA cert from k8s Secret (generate if absent).
# The CA cert is exchanged during peering and used to authenticate the WS channel.
_CA_PEM, _CA_KEY_PEM = tls.load_or_generate_ca(state.AGENT_NAME, state.NAMESPACE)

state.AGENT_CA_PEM = _CA_PEM

# Compute a version fingerprint from key protocol files. Used to detect
# version mismatches when peers connect over WebSocket.
def _compute_version_hash() -> str:
    h = hashlib.sha256()
    _here = pathlib.Path(__file__).parent
    for fname in sorted(["channel.py", "channel_handlers.py", "models.py"]):
        p = _here / fname
        if p.exists():
            h.update(p.read_bytes())
    # Include schema.yaml so schema changes are detected across peers
    _schema = _here.parent / "charts" / "porpulsion" / "files" / "schema.yaml"
    if _schema.exists():
        h.update(_schema.read_bytes())
    return h.hexdigest()[:16]

state.VERSION_HASH = _compute_version_hash()
log.info("SELF_URL=%s  VERSION_HASH=%s", state.SELF_URL, state.VERSION_HASH)

# ── Restore persisted state ───────────────────────────────────

from porpulsion.models import Peer  # noqa: E402

# Load and cache the RemoteApp spec schema from the baked-in schema.yaml.
# Must run before any RemoteAppSpec.from_dict() call.
from porpulsion.k8s.store import load_spec_schema as _load_spec_schema  # noqa: E402
_load_spec_schema()

for _p in tls.load_peers(state.NAMESPACE):
    state.peers[_p["name"]] = Peer(
        name=_p["name"], url=_p["url"], ca_pem=_p.get("ca_pem", ""))

_saved = tls.load_state_configmap(state.NAMESPACE)
if "settings" in _saved:
    for _k, _v in _saved["settings"].items():
        if hasattr(state.settings, _k):
            setattr(state.settings, _k, _v)
for _entry in _saved.get("pending_approval", []):
    if _entry.get("id"):
        state.pending_approval[_entry["id"]] = _entry

log.info("Restored %d peer(s), %d pending approval(s) from persistent storage",
         len(state.peers), len(state.pending_approval))

# Re-open WS channels for any peers restored from persistent storage.
# Runs after the Flask app starts (deferred so the WS endpoint is registered).
# Both sides attempt outbound — whichever connects first stays up. If the peer
# also connects inbound simultaneously, accept_channel replaces the outbound
# channel cleanly. This ensures reconnection works regardless of which side
# restarted.
def _reconnect_persisted_peers():
    import time as _time
    _time.sleep(3)  # let the server fully start before connecting outbound
    from porpulsion.channel import open_channel_to
    for _p in state.peers.values():
        log.info("Re-opening WS channel to persisted peer %s", _p.name)
        open_channel_to(_p.name, _p.url, _p.ca_pem)

# ── Flask app ─────────────────────────────────────────────────

_TEMPLATES = pathlib.Path(__file__).parent.parent / "templates"
_STATIC    = pathlib.Path(__file__).parent.parent / "static"
app = Flask(__name__,
            template_folder=str(_TEMPLATES),
            static_folder=str(_STATIC),
            static_url_path="/static")

# Session secret — load from env or fall back to a stable derivation from the CA key.
# The CA key is already secret and cluster-unique, so its hash makes a safe default.
_session_secret = os.environ.get("SECRET_KEY")
if not _session_secret:
    import hashlib as _hashlib
    _session_secret = _hashlib.sha256(_CA_KEY_PEM).hexdigest()
app.secret_key = _session_secret

# Server-side sessions — each browser tab gets its own independent session ID,
# so logging in/out in one tab doesn't affect other tabs.
import tempfile as _tempfile
from flask_session import Session as _Session
app.config["SESSION_TYPE"] = "filesystem"
app.config["SESSION_FILE_DIR"] = _tempfile.mkdtemp(prefix="porpulsion-sessions-")
app.config["SESSION_PERMANENT"] = False
app.config["SESSION_USE_SIGNER"] = True
_Session(app)

app.register_blueprint(auth_bp.bp)
app.register_blueprint(peers_bp.bp, url_prefix="/api")
app.register_blueprint(workloads_bp.bp, url_prefix="/api")
app.register_blueprint(tunnels_bp.bp, url_prefix="/api")
app.register_blueprint(settings_bp.bp, url_prefix="/api")
app.register_blueprint(logs_bp.bp, url_prefix="/api")
app.register_blueprint(notifications_bp.bp, url_prefix="/api")
app.register_blueprint(ui_bp.bp)

# ── API auth guard ────────────────────────────────────────────
# Port 8001 (peer_server) handles all inter-agent traffic.
# Port 8002 (internal_server) handles probes — no auth needed there.
# Everything on port 8000 under /api/ is dashboard-only and requires a session.

@app.before_request
def _require_api_auth():
    from flask import request, session, jsonify
    import base64 as _b64
    if not request.path.startswith("/api/"):
        return
    # Session cookie (browser)
    if session.get("user"):
        return
    # HTTP Basic Auth (curl / scripts)
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Basic "):
        try:
            username, password = _b64.b64decode(auth_header[6:]).decode().split(":", 1)
            from porpulsion.routes.auth import _load_users, _verify_password
            users = _load_users()
            if username in users and _verify_password(password, users[username]["hash"]):
                return
        except Exception:
            pass
    return jsonify({"error": "unauthorized"}), 401



@app.route("/api/openapi.json")
def openapi_json():
    """Serve generated OpenAPI 3 spec (JSON)."""
    from porpulsion.openapi_spec import get_openapi_dict
    return jsonify(get_openapi_dict())


@app.route("/api/openapi.yaml")
def openapi_yaml():
    """Serve generated OpenAPI 3 spec (YAML)."""
    from porpulsion.openapi_spec import get_openapi_yaml
    return Response(get_openapi_yaml(), mimetype="application/x-yaml")


# ── Main ──────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("Starting agent %s", state.AGENT_NAME)

    level = getattr(logging, state.settings.log_level.upper(), logging.INFO)
    logging.getLogger().setLevel(level)

    threading.Thread(target=_reconnect_persisted_peers, daemon=True).start()

    # CR watcher: drives workload execution from ExecutingApp CRs.
    # RemoteApp CRs are also watched: new/updated CRs with a targetPeer are
    # forwarded to that peer via the WS channel.
    def _on_cr_added_or_modified(cr: dict, is_new: bool) -> None:
        from porpulsion.k8s.store import cr_to_dict
        from porpulsion.models import RemoteApp, RemoteAppSpec

        kind = cr.get("kind", "")

        if kind == "ExecutingApp":
            from porpulsion.k8s.executor import run_workload
            d = cr_to_dict(cr, "executing")
            if not d["id"]:
                return  # appId not yet bootstrapped — MODIFIED will follow
            spec = RemoteAppSpec.from_dict(d.get("spec", {}))
            ra = RemoteApp(
                id=d["id"], name=d["name"], spec=spec,
                source_peer=d["source_peer"],
                resource_name=d.get("resource_name", ""),
            )
            ra.cr_name = d.get("cr_name", "")
            log.info("CR watcher: %s ExecutingApp %s (%s) → running workload",
                     "new" if is_new else "updated", d["name"], d["id"])
            run_workload(ra, d["source_peer"])

        elif kind == "RemoteApp":
            # A RemoteApp CR was added or modified.
            # Forward to the target peer via the channel.
            d = cr_to_dict(cr, "submitted")
            if not d["id"]:
                return  # not bootstrapped yet
            target_peer_name = d.get("target_peer", "")
            if not target_peer_name:
                return  # no target — nothing to forward
            peer = state.peers.get(target_peer_name)
            if not peer:
                log.warning("CR watcher: RemoteApp %s targets peer %r which is not connected — skipping forward",
                            d["name"], target_peer_name)
                return
            spec_dict = d.get("spec", {})
            msg_type = "remoteapp/receive" if is_new else "remoteapp/spec-update"
            payload = {"id": d["id"], "spec": spec_dict, "source_peer": state.AGENT_NAME}
            if is_new:
                payload["name"] = d["name"]
            try:
                from porpulsion.channel import get_channel
                ch = get_channel(peer.name)
                ch.call(msg_type, payload)
                log.info("CR watcher: %s RemoteApp %s (%s) to peer %s",
                         "forwarded new" if is_new else "forwarded updated", d["name"], d["id"], peer.name)
            except Exception as e:
                log.warning("CR watcher: failed to forward RemoteApp %s to peer %s: %s",
                            d["name"], peer.name, e)

    from porpulsion.k8s.store import start_cr_watcher as _start_cr_watcher
    _start_cr_watcher(
        state.NAMESPACE,
        on_added=lambda cr: _on_cr_added_or_modified(cr, is_new=True),
        on_modified=lambda cr: _on_cr_added_or_modified(cr, is_new=False),
    )

    # Peer-facing server (port 8001): /peer and /ws only.
    # This is the only port exposed via the Ingress.
    from porpulsion.peer_server import start as _start_peer_server
    threading.Thread(target=_start_peer_server, daemon=True, name="peer-server").start()

    # Internal server (port 8002): /status and probes only, no auth.
    from porpulsion.internal_server import start as _start_internal_server
    threading.Thread(target=_start_internal_server, daemon=True, name="internal-server").start()

    # Dashboard + API (port 8000): session auth required.
    app.run(host="0.0.0.0", port=8000, threaded=True)
