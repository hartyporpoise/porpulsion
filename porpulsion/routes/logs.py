import logging

from flask import Blueprint, request, jsonify, Response

from porpulsion.log_buffer import get_recent_logs

log = logging.getLogger("porpulsion.routes.logs")

bp = Blueprint("logs", __name__)

TAIL_DEFAULT = 200
TAIL_MAX = 500


@bp.route("/logs")
def get_logs():
    tail = request.args.get("tail", default=TAIL_DEFAULT, type=int)
    tail = max(1, min(TAIL_MAX, tail))
    fmt = (request.args.get("format") or "json").strip().lower()

    lines = get_recent_logs(limit=tail)

    if fmt == "text":
        text = "\n".join(entry["message"] for entry in lines)
        return Response(text, mimetype="text/plain; charset=utf-8")

    return jsonify({"lines": lines})
