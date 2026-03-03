"""
Peer-facing Flask app (port 8001).

Exposes only the two endpoints that remote peers need to reach:
  POST /peer   — peering handshake
  GET  /ws     — persistent WebSocket channel

Everything else (dashboard, local API) lives on port 8000 and is never
exposed via the Ingress.
"""
import logging

from flask import Flask
from flask_sock import Sock

from porpulsion.routes.peers import accept_peer
from porpulsion.routes.ws import peer_ws

log = logging.getLogger("porpulsion.peer_server")

peer_app = Flask(__name__)

peer_app.add_url_rule("/peer", view_func=accept_peer, methods=["POST"])

sock = Sock(peer_app)
sock.route("/ws")(peer_ws)


class _StripServerHeader:
    """WSGI middleware that removes the Werkzeug Server banner."""
    def __init__(self, app):
        self._app = app

    def __call__(self, environ, start_response):
        def _start(status, headers, exc_info=None):
            headers = [(k, v) for k, v in headers if k.lower() != "server"]
            return start_response(status, headers, exc_info)
        return self._app(environ, _start)


def start(port: int = 8001):
    """Start the peer-facing server in the calling thread (run in a daemon thread)."""
    from werkzeug.serving import make_server
    log.info("Starting peer-facing server on port %d", port)
    srv = make_server("0.0.0.0", port, _StripServerHeader(peer_app), threaded=True)
    srv.serve_forever()
