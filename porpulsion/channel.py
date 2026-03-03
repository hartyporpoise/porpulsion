"""
Persistent WebSocket channel between peers.

After the peering handshake completes, the initiating side opens a
WebSocket connection to the accepting peer's /ws endpoint. All
subsequent peer-to-peer communication (workload submission, status callbacks,
proxy tunnelling) flows over this single persistent connection instead of
making new outbound HTTPS requests for each call.

This sidesteps the nginx client-cert-forwarding problem entirely: the WS
upgrade is a plain HTTPS request (nginx handles it fine), and once the
connection is established both sides authenticate via the CA cert check on
the first frame. No client cert needs to reach the Flask app.

Message framing (JSON):

  Request  {"id": "<uuid4-hex>", "type": "<method>", "payload": {...}}
  Reply    {"id": "<same>",       "type": "reply",    "ok": true|false,
            "payload": {...},     "error": "<str>"}    # error only when ok=false
  Push     {"type": "<event>",   "payload": {...}}     # no id — fire-and-forget

Types:
  remoteapp/receive       submit a RemoteApp to the peer for execution
  remoteapp/status        status update from executor back to submitter
  remoteapp/delete        delete a running RemoteApp
  remoteapp/scale         scale a RemoteApp
  remoteapp/detail        fetch k8s detail for a RemoteApp
  remoteapp/spec-update   push a new spec to the executor
  proxy/request           HTTP proxy request (payload includes base64 body)
  proxy/response          HTTP proxy response
  peer/disconnect         graceful disconnect notification
  ping                    keepalive
"""
import base64
import json
import logging
import threading
import time
import uuid

import websocket  # websocket-client

log = logging.getLogger("porpulsion.channel")


class _SimpleWsSendAdapter:
    """
    Thin wrapper around a simple_websocket server socket that exposes
    only the send() method needed by _send_raw and _ping_loop.
    recv() is NOT delegated here — the inbound recv loop reads from the
    raw sock object directly to stay on the correct thread.
    """

    def __init__(self, sock):
        self._sock = sock

    def send(self, data: str):
        self._sock.send(data)

    def close(self):
        try:
            self._sock.close()
        except Exception:
            pass

def _emit_reconnect_failure(peer_name: str):
    try:
        from porpulsion.notifications import add_notification
        add_notification(
            level="error",
            title=f"Channel unreachable: {peer_name}",
            message=f"Lost connection to {peer_name!r} and repeated reconnects are failing. Will keep retrying.",
        )
        log.warning("Persistent reconnect failure to peer %s", peer_name)
    except Exception as exc:
        log.debug("Could not emit reconnect failure notification: %s", exc)


def _emit_version_mismatch(peer_name: str, peer_ver: str):
    try:
        from porpulsion import state as _state
        from porpulsion.notifications import add_notification
        add_notification(
            level="warn",
            title=f"Version mismatch with {peer_name}",
            message=(
                f"Local: {_state.VERSION_HASH[:8]}  \u2502  {peer_name}: {peer_ver[:8]}. "
                "Some features may not work correctly."
            ),
        )
        log.warning("Version mismatch with peer %s (local=%s peer=%s)",
                    peer_name, _state.VERSION_HASH[:8], peer_ver[:8])
    except Exception as exc:
        log.debug("Could not emit version mismatch notification: %s", exc)


def _push_crd_schema(channel: "PeerChannel"):
    """Push our local CRD spec property names to the peer after connect."""
    try:
        from porpulsion.k8s.store import get_spec_properties
        props = get_spec_properties()
        if props is not None:
            channel.push("crd/schema-announce", {"properties": list(props.keys())})
    except Exception as exc:
        log.debug("Could not push CRD schema to %s: %s", channel.peer_name, exc)


def _handle_crd_schema_announce(peer_name: str, payload: dict):
    """
    Receive a peer's CRD spec property list, compare against ours, and
    store the diff on the peer object (used by _check_crd_compatibility).
    Schema mismatches are surfaced via the existing version-hash warning;
    no separate notification is fired here.
    """
    try:
        from porpulsion import state as _state
        from porpulsion.k8s.store import get_spec_properties, compare_spec_schemas

        peer_prop_names: list[str] = payload.get("properties", [])
        local_props = get_spec_properties()

        if local_props is None:
            return

        peer_props = {k: {} for k in peer_prop_names}
        diff = compare_spec_schemas(local_props, peer_props)

        peer = _state.peers.get(peer_name)
        if peer is not None:
            peer.crd_diff = diff

        missing_local  = diff["missing_local"]
        missing_remote = diff["missing_remote"]
        if missing_local or missing_remote:
            log.warning("CRD schema mismatch with %s — missing_remote=%s missing_local=%s",
                        peer_name, missing_remote, missing_local)
        else:
            log.info("CRD schemas in sync with peer %s", peer_name)
    except Exception as exc:
        log.debug("CRD schema comparison failed: %s", exc)


_CONNECT_TIMEOUT = 5      # seconds for WS handshake
_RECV_TIMEOUT    = 30     # seconds before treating connection as dead
_RECONNECT_DELAY = (2, 4, 8, 16, 30)   # backoff steps in seconds
_PING_INTERVAL   = 20     # seconds between keepalive pings


class PeerChannel:
    """
    Manages a persistent WebSocket connection to one peer.

    The initiating side creates and owns the channel (outbound connect).
    The accepting side's ws.py handler calls attach_inbound() to hand an
    already-open server socket into the same channel object so both sides
    share the same message dispatch logic.

    Thread-safety: _ws and _pending are guarded by _lock.
    """

    def __init__(self, peer_name: str, peer_url: str, ca_pem: str = ""):
        self.peer_name = peer_name
        self.peer_url  = peer_url   # peer's public URL — WS connects here
        self.ca_pem    = ca_pem
        self.peer_version_hash: str = ""   # set when peer announces its version
        self._ws: websocket.WebSocket | None = None
        self._lock     = threading.Lock()
        self._pending: dict[str, dict] = {}   # id -> {"event": Event, "result": dict|None}
        self._running  = True
        self._handlers: dict[str, "callable"] = {}
        self._recv_thread: threading.Thread | None = None
        self.connected_event = threading.Event()   # set once the channel is ready to use

    # ── Public API ────────────────────────────────────────────

    def register(self, msg_type: str, handler):
        """Register a handler for an incoming message type."""
        self._handlers[msg_type] = handler

    def call(self, msg_type: str, payload: dict, timeout: float = 10.0) -> dict:
        """
        Send a request and block until the peer replies.
        Returns the reply payload dict, or raises RuntimeError on error/timeout.
        """
        req_id = uuid.uuid4().hex
        event  = threading.Event()
        self._pending[req_id] = {"event": event, "result": None}
        self._send_raw({"id": req_id, "type": msg_type, "payload": payload})
        fired = event.wait(timeout)
        result = self._pending.pop(req_id, {}).get("result")
        if not fired or result is None:
            raise RuntimeError(f"timeout waiting for reply to {msg_type}")
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "peer error"))
        return result.get("payload", {})

    def push(self, msg_type: str, payload: dict):
        """Send a fire-and-forget message (no reply expected)."""
        self._send_raw({"type": msg_type, "payload": payload})

    def close(self):
        """Gracefully shut down the channel."""
        self._running = False
        with self._lock:
            if self._ws:
                try:
                    self._ws.close()
                except Exception:
                    pass
                self._ws = None

    def is_connected(self) -> bool:
        return self.connected_event.is_set()

    # ── Inbound (server side) ─────────────────────────────────

    def attach_inbound(self, sock):
        """
        Called by the WS server handler (routes/ws.py) to hand off the
        already-authenticated server socket. Runs the recv loop in the CALLING
        thread (the flask-sock handler thread) — this is required because
        simple_websocket does not support recv() from a different thread.
        Blocks until the connection closes.
        """
        # Store the socket using a private attribute that _send_raw can reach.
        # We wrap it in a thin adapter so _send_raw / _ping_loop work unchanged.
        with self._lock:
            self._ws = _SimpleWsSendAdapter(sock)
        self.connected_event.set()

        # Announce our version so the peer can detect mismatches
        try:
            from porpulsion import state as _state
            self.push("version/announce", {"version": _state.VERSION_HASH})
        except Exception:
            pass

        # Share our CRD spec properties so the peer can flag schema mismatches
        _push_crd_schema(self)

        # Start keepalive ping thread (same as outbound side)
        threading.Thread(target=self._ping_loop, daemon=True).start()

        # Run the recv loop directly in this (handler) thread.
        self._inbound_recv_loop(sock)

    # ── Outbound (client side) ────────────────────────────────

    def connect_and_maintain(self):
        """
        Blocking loop: connect to the peer's /ws endpoint and keep the
        connection alive, reconnecting on failure. Run in a daemon thread.
        """
        attempt = 0
        _notified_failure = False   # emit reconnect-failure notification once per outage
        while self._running:
            try:
                self._connect()
            except Exception as exc:
                if not self._running:
                    return
                delay = _RECONNECT_DELAY[min(attempt, len(_RECONNECT_DELAY) - 1)]
                log.warning("Channel to %s: connect failed (%s) — retrying in %ds",
                            self.peer_name, exc, delay)
                attempt += 1
                # Notify once when we've exhausted the fast retries (after ~14s)
                if attempt == len(_RECONNECT_DELAY) and not _notified_failure:
                    _notified_failure = True
                    _emit_reconnect_failure(self.peer_name)
                time.sleep(delay)
                continue

            # Connected — reset backoff and clear failure flag
            attempt = 0
            _notified_failure = False
            self._recv_loop()

            if not self._running:
                return
            delay = _RECONNECT_DELAY[min(attempt, len(_RECONNECT_DELAY) - 1)]
            log.info("Channel to %s dropped — reconnecting in %ds", self.peer_name, delay)
            attempt += 1
            time.sleep(delay)

    def _connect(self):
        from porpulsion import tls, state

        # WS goes to the peer's public URL (nginx in production, UI NodePort in dev).
        ws_url = self.peer_url.replace("https://", "wss://").replace("http://", "ws://")
        ws_url = ws_url.rstrip("/") + "/ws"

        # For WSS connections nginx (or the LB) presents a real TLS cert — let
        # websocket-client verify it using the system CA bundle (certifi).
        # For plain WS there's nothing to verify.
        ssl_opts: dict = {}

        # Send our CA PEM base64-encoded — PEM contains newlines which would
        # break HTTP header framing if sent raw.
        ca_b64 = base64.b64encode(state.AGENT_CA_PEM).decode()
        ws = websocket.WebSocket(sslopt=ssl_opts)
        ws.connect(ws_url, timeout=_CONNECT_TIMEOUT, header={
            "X-Agent-Name": state.AGENT_NAME,
            "X-Agent-Ca":   ca_b64,
        })
        # Reset timeout to None after handshake — the connect() timeout would
        # otherwise persist and cause recv() to raise WebSocketTimeoutException
        # after _CONNECT_TIMEOUT seconds of inactivity, dropping the channel.
        ws.settimeout(None)
        with self._lock:
            self._ws = ws
        self.connected_event.set()
        log.info("WebSocket channel connected to %s", self.peer_name)

        # Announce our version so the peer can detect mismatches
        try:
            from porpulsion import state as _state
            self.push("version/announce", {"version": _state.VERSION_HASH})
        except Exception:
            pass

        # Share our CRD spec properties so the peer can flag schema mismatches
        _push_crd_schema(self)

        # Start keepalive ping thread
        threading.Thread(target=self._ping_loop, daemon=True).start()

    # ── Recv loop (server / inbound side) ────────────────────

    def _inbound_recv_loop(self, sock):
        """
        Recv loop for the inbound (server) side using simple_websocket's API.
        Runs in the flask-sock handler thread. simple_websocket raises
        ConnectionClosed (a subclass of Exception) when the peer disconnects;
        we catch that and exit cleanly.
        """
        try:
            from simple_websocket import ConnectionClosed
        except ImportError:
            ConnectionClosed = Exception  # fallback if package layout changes

        while self._running:
            try:
                raw = sock.receive()
            except ConnectionClosed as exc:
                log.info("Inbound channel from %s closed: %s", self.peer_name, exc)
                break
            except Exception as exc:
                if self._running:
                    log.info("Inbound channel recv error from %s: %s", self.peer_name, exc)
                break

            if raw is None:
                continue
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("Channel: bad JSON from %s", self.peer_name)
                continue
            self._dispatch(msg)

        with self._lock:
            self._ws = None
        self.connected_event.clear()
        for entry in self._pending.values():
            entry["event"].set()

    # ── Recv loop (client / outbound side) ───────────────────

    def _recv_loop(self):
        while self._running:
            ws = self._ws
            if ws is None:
                break
            try:
                raw = ws.recv()
            except Exception as exc:
                if self._running:
                    log.info("Channel to %s closed: %s", self.peer_name, exc)
                break

            if raw is None:
                continue
            if raw == "":
                # Empty frame — websocket-client returns "" on clean close
                log.info("Channel to %s: empty recv (clean close)", self.peer_name)
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("Channel: bad JSON from %s", self.peer_name)
                continue

            self._dispatch(msg)

        with self._lock:
            self._ws = None
        self.connected_event.clear()
        # Wake any callers blocked in call() so they get a timeout error
        for entry in self._pending.values():
            entry["event"].set()

    def _dispatch(self, msg: dict):
        msg_id   = msg.get("id")
        msg_type = msg.get("type", "")
        payload  = msg.get("payload", {})

        # Reply to one of our pending requests
        if msg_id and msg_id in self._pending:
            self._pending[msg_id]["result"] = msg
            self._pending[msg_id]["event"].set()
            return

        # Incoming request — find a handler and send a reply
        if msg_id:
            handler = self._handlers.get(msg_type)
            if handler:
                try:
                    result = handler(payload)
                    self._send_raw({"id": msg_id, "type": "reply",
                                    "ok": True, "payload": result or {}})
                except Exception as exc:
                    log.warning("Handler %s raised: %s", msg_type, exc)
                    self._send_raw({"id": msg_id, "type": "reply",
                                    "ok": False, "error": str(exc), "payload": {}})
            else:
                self._send_raw({"id": msg_id, "type": "reply",
                                "ok": False, "error": f"unknown type: {msg_type}",
                                "payload": {}})
            return

        # Fire-and-forget push
        if msg_type == "ping":
            return
        if msg_type == "version/announce":
            peer_ver = payload.get("version", "")
            self.peer_version_hash = peer_ver
            if peer_ver:
                from porpulsion import state as _state
                if _state.VERSION_HASH and peer_ver != _state.VERSION_HASH:
                    _emit_version_mismatch(self.peer_name, peer_ver)
            return
        if msg_type == "crd/schema-announce":
            _handle_crd_schema_announce(self.peer_name, payload)
            return
        handler = self._handlers.get(msg_type)
        if handler:
            try:
                handler(payload)
            except Exception as exc:
                log.warning("Push handler %s raised: %s", msg_type, exc)

    def _send_raw(self, msg: dict):
        with self._lock:
            ws = self._ws
        if ws is None:
            raise RuntimeError(f"channel to {self.peer_name} is not connected")
        try:
            ws.send(json.dumps(msg))
        except Exception as exc:
            with self._lock:
                self._ws = None
            raise RuntimeError(f"channel send failed: {exc}") from exc

    def _ping_loop(self):
        while self._running and self._ws is not None:
            time.sleep(_PING_INTERVAL)
            try:
                self.push("ping", {})
            except Exception:
                break


# ── Convenience helpers used by route handlers ────────────────

def get_channel(peer_name: str, wait: float = 8.0) -> "PeerChannel":
    """
    Return the live channel to a peer.

    Waits up to `wait` seconds for the channel to connect (handles the race
    between open_channel_to starting the background thread and the first call
    being made immediately after peering completes). Raises RuntimeError if
    the channel is not available within the timeout.
    """
    from porpulsion import state
    ch = state.peer_channels.get(peer_name)
    if ch is None:
        raise RuntimeError(f"no live channel to peer '{peer_name}'")
    if not ch.connected_event.wait(timeout=wait):
        raise RuntimeError(f"no live channel to peer '{peer_name}'")
    return ch


def open_channel_to(peer_name: str, peer_url: str, ca_pem: str = "") -> "PeerChannel":
    """
    Create a PeerChannel for peer_name and start the outbound connect loop
    in a daemon thread. Replaces any existing channel for this peer.
    """
    from porpulsion import state
    old = state.peer_channels.get(peer_name)
    if old:
        old.close()

    ch = PeerChannel(peer_name, peer_url, ca_pem)
    _register_handlers(ch)
    state.peer_channels[peer_name] = ch

    t = threading.Thread(target=ch.connect_and_maintain, daemon=True,
                         name=f"ws-chan-{peer_name}")
    t.start()
    return ch


def accept_channel(peer_name: str, sock) -> "PeerChannel":
    """
    Called by the WS server endpoint when a peer connects to us.

    If we already have an active outbound channel to this peer (we are the
    designated initiator), close it — the peer has reconnected inbound, so
    we switch to serving their connection. This avoids both sides trying to
    own the channel simultaneously.
    """
    from porpulsion import state
    peer = state.peers.get(peer_name)
    peer_url = peer.url if peer else ""
    ca_pem   = peer.ca_pem if peer else ""

    old = state.peer_channels.get(peer_name)
    if old:
        # Stop the old channel (outbound loop or previous inbound).
        old.close()

    ch = PeerChannel(peer_name, peer_url, ca_pem)
    _register_handlers(ch)
    state.peer_channels[peer_name] = ch
    ch.attach_inbound(sock)   # blocks until the connection closes
    return ch


def _register_handlers(ch: "PeerChannel"):
    """Wire up all the message type handlers on a channel."""
    from porpulsion.channel_handlers import (
        handle_remoteapp_receive,
        handle_remoteapp_status,
        handle_remoteapp_delete,
        handle_remoteapp_scale,
        handle_remoteapp_detail,
        handle_remoteapp_logs,
        handle_remoteapp_spec_update,
        handle_remoteapp_config_patch,
        handle_proxy_request,
        handle_peer_disconnect,
    )
    ch.register("remoteapp/receive",       handle_remoteapp_receive)
    ch.register("remoteapp/status",        handle_remoteapp_status)
    ch.register("remoteapp/delete",        handle_remoteapp_delete)
    ch.register("remoteapp/scale",         handle_remoteapp_scale)
    ch.register("remoteapp/detail",        handle_remoteapp_detail)
    ch.register("remoteapp/logs",          handle_remoteapp_logs)
    ch.register("remoteapp/spec-update",   handle_remoteapp_spec_update)
    ch.register("remoteapp/config-patch",  handle_remoteapp_config_patch)
    # Wrap proxy handler so it can enforce the per-peer tunnel allowlist.
    def _proxy_handler(payload, _peer=ch.peer_name):
        return handle_proxy_request(payload, peer_name=_peer)
    ch.register("proxy/request", _proxy_handler)
    ch.register("peer/disconnect",       handle_peer_disconnect)
