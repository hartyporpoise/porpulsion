"""
Porpulsion agent entrypoint.

Initialises runtime config (TLS, invite token, env vars) into the shared
state module, registers Flask blueprints, and starts the HTTP server.

All traffic is served on a single port (8000) via gunicorn gthread:
  - Dashboard, API (/api/*): session auth required
  - Peer WebSocket (/ws): open to peers, auth via peer/hello frame
  - Health probes (/status): no auth
"""
import hashlib
import logging
import os
import pathlib
import socket
import threading

from flask import Flask, Response, jsonify, request
from flask_sock import Sock

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
from porpulsion.routes import image_proxy as image_proxy_bp
from porpulsion.routes.ws import peer_ws

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
install_log_handler(1000)
log = logging.getLogger("porpulsion.agent")

# -- Bootstrap config

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
        "SELF_URL not set - auto-detected as %s. "
        "This is a pod-internal IP and will cause peering to fail across clusters. "
        "Set agent.selfUrl in your Helm values to the externally reachable URL for "
        "this agent (e.g. https://porpulsion.example.com).",
        state.SELF_URL
    )

# Load CA cert + key from k8s Secret (generate if absent).
# The CA cert is included in signed invite bundles and used to verify peer/hello
# challenge signatures. The key signs bundles and hello challenges — never leaves
# this process.
_CA_PEM, _CA_KEY_PEM = tls.load_or_generate_ca(state.AGENT_NAME, state.NAMESPACE)

state.AGENT_CA_PEM     = _CA_PEM
state.AGENT_CA_KEY_PEM = _CA_KEY_PEM


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

# -- Restore persisted state

from porpulsion.models import Peer  # noqa: E402

# Load and cache the RemoteApp spec schema from the baked-in schema.yaml.
# Must run before any RemoteAppSpec.from_dict() call.
from porpulsion.k8s.store import load_spec_schema as _load_spec_schema  # noqa: E402
_load_spec_schema()

for _p in tls.load_peers(state.NAMESPACE):
    # Migrate old format: initiator(bool) + has_inbound(bool) → direction(str)
    if "direction" not in _p:
        _ini, _inb = _p.get("initiator", False), _p.get("has_inbound", False)
        _p["direction"] = "bidirectional" if (_ini and _inb) else ("outgoing" if _ini else "incoming")
    state.peers[_p["name"]] = Peer(
        name=_p["name"], url=_p["url"], ca_pem=_p.get("ca_pem", ""),
        direction=_p["direction"])

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
# Both sides attempt outbound - whichever connects first stays up. If the peer
# also connects inbound simultaneously, accept_channel replaces the outbound
# channel cleanly. This ensures reconnection works regardless of which side
# restarted.
# Ensure registry system user + pull secret exist when feature is enabled (idempotent)
if state.settings.registry_pull_enabled:
    try:
        from porpulsion.k8s.registry_proxy import ensure_registry_setup
        ensure_registry_setup(state.NAMESPACE, state.SELF_URL)
    except Exception as _rp_exc:
        log.warning("Could not set up registry proxy: %s", _rp_exc)


def _reconnect_persisted_peers():
    import time as _time
    _time.sleep(3)  # let the server fully start before connecting outbound
    from porpulsion.channel import open_channel_to
    for _p in state.peers.values():
        if not _p.url or _p.direction == "incoming":
            log.debug("Skipping reconnect for incoming peer %s (no outbound URL)", _p.name)
            continue
        log.info("Re-opening WS channel to persisted peer %s", _p.name)
        open_channel_to(_p.name, _p.url, _p.ca_pem)

# -- Flask app

_TEMPLATES = pathlib.Path(__file__).parent.parent / "templates"
_STATIC    = pathlib.Path(__file__).parent.parent / "static"
app = Flask(__name__,
            template_folder=str(_TEMPLATES),
            static_folder=str(_STATIC),
            static_url_path="/static")

# Session secret - load from env or fall back to a stable derivation from the CA key.
# The CA key is already secret and cluster-unique, so its hash makes a safe default.
_session_secret = os.environ.get("SECRET_KEY")
if not _session_secret:
    import hashlib as _hashlib
    _session_secret = _hashlib.sha256(_CA_KEY_PEM).hexdigest()
app.secret_key = _session_secret

# Server-side sessions - each browser tab gets its own independent session ID,
# so logging in/out in one tab doesn't affect other tabs.
import pathlib as _pathlib
from flask_session import Session as _Session
_session_dir = _pathlib.Path("/tmp/porpulsion-sessions")
_session_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
app.config["SESSION_TYPE"] = "filesystem"
app.config["SESSION_FILE_DIR"] = str(_session_dir)
app.config["SESSION_PERMANENT"] = False
app.config["SESSION_USE_SIGNER"] = True
_Session(app)

# Peer WebSocket endpoint — open to peers, auth handled inside the channel via
# the peer/hello frame. No session required.
_sock = Sock(app)
_sock.route("/ws")(peer_ws)

app.register_blueprint(auth_bp.bp)
app.register_blueprint(peers_bp.bp, url_prefix="/api")
app.register_blueprint(workloads_bp.bp, url_prefix="/api")
app.register_blueprint(tunnels_bp.bp, url_prefix="/api")
app.register_blueprint(settings_bp.bp, url_prefix="/api")
app.register_blueprint(logs_bp.bp, url_prefix="/api")
app.register_blueprint(notifications_bp.bp, url_prefix="/api")
app.register_blueprint(image_proxy_bp.bp, url_prefix="/api")
app.register_blueprint(ui_bp.bp)


# -- Health probe (no auth — must be reachable by kubelet)

@app.route("/status")
def status():
    return jsonify({"ok": True})


# -- CSRF protection
# Inject `csrf_token()` into every Jinja2 template and validate the token on
# all HTML form POSTs (routes that are not under /api/).

from porpulsion.csrf import generate_token as _csrf_generate, validate_token as _csrf_validate

@app.context_processor
def _csrf_context():
    return {"csrf_token": _csrf_generate}

_CSRF_PROTECTED_PATHS = ("/login", "/logout", "/users/add", "/users/edit", "/users/remove", "/signup")

@app.before_request
def _ensure_csrf_token():
    """Eagerly create the CSRF token on GETs so it's in the session before the response is sent."""
    if request.method == "GET" and not request.path.startswith("/api/") and request.path != "/status":
        _csrf_generate()

@app.before_request
def _check_csrf():
    if request.method == "POST" and any(request.path == p for p in _CSRF_PROTECTED_PATHS):
        _csrf_validate()


# -- API auth guard
# /ws and /status are open. Everything under /api/ and /static/js/ requires auth.

@app.before_request
def _require_api_auth():
    from flask import request, session, jsonify
    import base64 as _b64
    _GUARDED = ("/api/", "/static/js/")
    if not any(request.path.startswith(p) for p in _GUARDED):
        return
    # Session cookie (browser)
    if session.get("user"):
        return
    # HTTP Basic Auth (curl / scripts) - only honoured for /api/ paths
    if request.path.startswith("/api/"):
        # Probe URL map to distinguish unknown routes (-> 404) from known-but-auth-gated (-> 401).
        # We must do this ourselves because before_request fires before route matching.
        _adapter = app.url_map.bind(request.host)
        try:
            _adapter.match(request.path, method=request.method)
        except Exception as _e:
            _ename = type(_e).__name__
            if _ename == "NotFound":
                return jsonify({"error": "not found"}), 404
            # MethodNotAllowed / RequestRedirect -> route exists, fall through to auth

        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Basic "):
            ip = request.remote_addr or "unknown"
            from porpulsion.routes.auth import (
                _load_users, _verify_password, _is_rate_limited, _record_failure, _clear_failures,
            )
            if _is_rate_limited(ip):
                return jsonify({"error": "too many failed attempts"}), 429
            try:
                username, password = _b64.b64decode(auth_header[6:]).decode().split(":", 1)
                users = _load_users()
                if username in users and _verify_password(password, users[username]["hash"]):
                    _clear_failures(ip)
                    return
            except Exception:
                pass
            _record_failure(ip)
        return jsonify({"error": "unauthorized"}), 401
    # For static assets, return 404 (asset simply won't load; user sees login page)
    from flask import abort
    abort(404)


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


# -- Main

def _run_kopf():
    """Start the kopf operator in a background thread (inside the gunicorn worker after fork)."""
    import asyncio
    import kopf
    import porpulsion.k8s.kopf_handlers  # noqa: F401 - registers handlers via decorators

    def _loop():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(kopf.operator(
            namespace=state.NAMESPACE,
            clusterwide=False,
            standalone=True,
            liveness_endpoint=None,
        ))

    threading.Thread(target=_loop, daemon=True, name="kopf-operator").start()
    log.info("Kopf operator started for namespace %s", state.NAMESPACE)


if __name__ == "__main__":
    log.info("Starting agent %s", state.AGENT_NAME)

    level = getattr(logging, state.settings.log_level.upper(), logging.INFO)
    logging.getLogger().setLevel(level)

    import gunicorn.app.base

    class _StandaloneApp(gunicorn.app.base.BaseApplication):
        def __init__(self, application, options=None):
            self.options = options or {}
            self.application = application
            super().__init__()

        def load_config(self):
            for key, value in self.options.items():
                self.cfg.set(key.lower(), value)

        def load(self):
            return self.application

    def _post_fork(server, worker):
        """Start kopf and peer reconnect inside the gunicorn worker after fork."""
        threading.Thread(target=_reconnect_persisted_peers, daemon=True).start()
        _run_kopf()

    worker_threads = int(os.environ.get("GUNICORN_THREADS", "4"))
    _StandaloneApp(app, {
        "bind":            "0.0.0.0:8000",
        "workers":         1,
        "worker_class":    "gthread",
        "threads":         worker_threads,
        "timeout":         120,
        "keepalive":       5,
        "loglevel":        "warning",
        "accesslog":       "-",
        "errorlog":        "-",
        "worker_tmp_dir":         "/tmp",
        "control_socket_disable": True,
        "post_fork":              _post_fork,
    }).run()
