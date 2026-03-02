"""UI routes — server-rendered pages at root (/", "/peers", etc.)."""
import logging
from functools import wraps

from flask import Blueprint, redirect, render_template, request, session, url_for

from porpulsion import state

log = logging.getLogger("porpulsion.routes.ui")

bp = Blueprint("ui", __name__)


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("user"):
            return redirect(url_for("auth.login", next=request.path))
        return f(*args, **kwargs)
    return decorated


def _context():
    return {"agent_name": state.AGENT_NAME, "current_user": session.get("user", "")}


@bp.route("/")
@login_required
def index():
    return render_template("ui/overview.html", **_context())


@bp.route("/peers")
@login_required
def peers():
    return render_template("ui/peers.html", **_context())


@bp.route("/workloads")
@login_required
def workloads():
    return render_template("ui/workloads.html", **_context())


@bp.route("/tunnels")
@login_required
def tunnels():
    return render_template("ui/tunnels.html", **_context())


@bp.route("/settings")
@login_required
def settings():
    return render_template("ui/settings.html", **_context())


@bp.route("/docs")
@login_required
def docs():
    return render_template("ui/docs.html", **_context())
