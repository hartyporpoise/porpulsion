"""
Internal server (port 8002) — no auth required.

Serves health/readiness probes and any other cluster-internal endpoints
that must be reachable without a user session (e.g. by the kubelet).
"""
import logging

from flask import Flask, jsonify

from porpulsion import state

log = logging.getLogger("porpulsion.internal_server")

internal_app = Flask(__name__)


@internal_app.route("/status")
def status():
    from porpulsion.k8s.store import list_remoteapp_crs, list_executingapp_crs
    return jsonify({
        "agent": state.AGENT_NAME,
        "peers": [p.to_dict() for p in state.peers.values()],
        "local_apps": len(list_remoteapp_crs(state.NAMESPACE)),
        "remote_apps": len(list_executingapp_crs(state.NAMESPACE)),
    })


def start(port: int = 8002):
    from werkzeug.serving import make_server
    log.info("Starting internal server on port %d", port)
    srv = make_server("0.0.0.0", port, internal_app, threaded=True)
    srv.serve_forever()
