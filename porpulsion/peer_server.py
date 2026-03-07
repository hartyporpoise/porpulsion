"""
Peer-facing Flask app (port 8001).

Exposes only the WebSocket endpoint that remote peers need to reach:
  GET /ws  - persistent WebSocket channel (auth via peer/hello frame)

Runs as a standalone gunicorn gthread process. Must be launched via
run_in_process() *before* any threads are created in the parent process
(i.e. before the main gunicorn for port 8000 starts), so the fork is clean.
"""
import logging

from flask import Flask
from flask_sock import Sock

from porpulsion.routes.ws import peer_ws

log = logging.getLogger("porpulsion.peer_server")

peer_app = Flask(__name__)

sock = Sock(peer_app)
sock.route("/ws")(peer_ws)


def run_in_process(port: int = 8001):
    """Launch a gunicorn gthread server for the peer app in a child process.

    Called before the main gunicorn (port 8000) starts, so the fork is clean
    (no threads exist in the parent yet). Returns the Process object - caller
    should not join it (it runs forever as a daemon-equivalent).
    """
    import multiprocessing
    import gunicorn.app.base

    class _App(gunicorn.app.base.BaseApplication):
        def load_config(self):
            for k, v in {
                "bind":         f"0.0.0.0:{port}",
                "workers":      1,
                "worker_class": "gthread",
                "threads":      4,
                "timeout":      300,   # WS connections are long-lived
                "keepalive":    5,
                "loglevel":     "warning",
                "accesslog":    "-",
                "errorlog":     "-",
            }.items():
                self.cfg.set(k, v)

        def load(self):
            return peer_app

    def _run():
        _App().run()

    p = multiprocessing.Process(target=_run, name="peer-server", daemon=True)
    p.start()
    return p
