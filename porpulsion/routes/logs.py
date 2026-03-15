import logging

from flask import Blueprint, request, jsonify, Response

from porpulsion.log_buffer import get_recent_logs
from porpulsion.openapi_spec import api_doc

log = logging.getLogger("porpulsion.routes.logs")

bp = Blueprint("logs", __name__)

TAIL_DEFAULT = 200
TAIL_MAX = 500


@bp.route("/logs")
@api_doc("Agent logs", tags=["General"],
         description="Recent in-process log lines. `tail` default 200 max 500. `format=text` returns plain text.",
         parameters=[
             {"name": "tail", "in": "query", "schema": {"type": "integer", "default": 200}},
             {"name": "format", "in": "query", "schema": {"type": "string", "enum": ["json", "text"], "default": "json"}},
         ],
         responses={"200": {"description": "OK"}})
def get_logs():
    tail = request.args.get("tail", default=TAIL_DEFAULT, type=int)
    tail = max(1, min(TAIL_MAX, tail))
    fmt = (request.args.get("format") or "json").strip().lower()

    lines = get_recent_logs(limit=tail)

    if fmt == "text":
        text = "\n".join(entry["message"] for entry in lines)
        return Response(text, mimetype="text/plain; charset=utf-8")

    return jsonify({"lines": lines})
