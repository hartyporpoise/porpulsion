"""
WebSocket endpoint for peer-to-peer channels.

Peers connect to /ws after obtaining this agent's signed invite bundle.
Authentication is handled entirely within the channel via the peer/hello
first frame — no HTTP headers or pre-handshake HTTP round trips required.
"""
import logging

from flask import Blueprint
from flask_sock import Sock

log = logging.getLogger("porpulsion.routes.ws")

bp = Blueprint("ws", __name__)


def peer_ws(ws):
    """
    Incoming WebSocket connection from a peer.

    The connection is handed to accept_channel which blocks waiting for the
    peer/hello first frame. That frame contains the peer's name, CA cert,
    and a challenge signature proving key possession. If verification passes
    the channel enters normal operation; otherwise the socket is closed.
    """
    from porpulsion.channel import accept_channel
    ch = accept_channel(ws)
    if ch:
        log.info("WS channel closed for peer %s", ch.peer_name)
    else:
        log.warning("WS channel rejected (hello auth failed) from unknown peer")
        try:
            ws.close(reason="unauthorized")
        except Exception:
            pass
