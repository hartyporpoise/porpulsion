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


def run_in_process(port: int = 8002):
    """Launch a gunicorn gthread server for the internal app in a child process.

    Called before the main gunicorn (port 8000) starts, so the fork is clean.
    """
    import multiprocessing
    import gunicorn.app.base

    class _App(gunicorn.app.base.BaseApplication):
        def load_config(self):
            for k, v in {
                "bind":         f"0.0.0.0:{port}",
                "workers":      1,
                "worker_class": "gthread",
                "threads":      2,
                "timeout":      30,
                "loglevel":     "warning",
                "accesslog":    "-",
                "errorlog":     "-",
            }.items():
                self.cfg.set(k, v)

        def load(self):
            return internal_app

    def _run():
        _App().run()

    p = multiprocessing.Process(target=_run, name="internal-server", daemon=True)
    p.start()
    return p
