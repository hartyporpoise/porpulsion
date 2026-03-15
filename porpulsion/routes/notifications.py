import logging

from flask import Blueprint, jsonify

from porpulsion import state
from porpulsion.openapi_spec import api_doc

log = logging.getLogger("porpulsion.routes.notifications")

bp = Blueprint("notifications", __name__)


@bp.route("/notifications")
@api_doc("List notifications", tags=["General"],
         description="In-app notifications (newest first, capped at 50).",
         responses={"200": {"description": "OK"}})
def list_notifications():
    return jsonify(state.notifications)


@bp.route("/notifications/<notif_id>/ack", methods=["POST"])
@api_doc("Acknowledge notification", tags=["General"],
         parameters=[{"name": "notif_id", "in": "path", "required": True, "schema": {"type": "string"}}],
         responses={"200": {"description": "OK"}, "404": {"description": "Not found"}})
def ack_notification(notif_id):
    for n in state.notifications:
        if n["id"] == notif_id:
            n["ack"] = True
            return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


@bp.route("/notifications/<notif_id>", methods=["DELETE"])
@api_doc("Delete notification", tags=["General"],
         parameters=[{"name": "notif_id", "in": "path", "required": True, "schema": {"type": "string"}}],
         responses={"200": {"description": "OK"}})
def delete_notification(notif_id):
    before = len(state.notifications)
    state.notifications[:] = [n for n in state.notifications if n["id"] != notif_id]
    return jsonify({"ok": len(state.notifications) < before})


@bp.route("/notifications", methods=["DELETE"])
@api_doc("Clear all notifications", tags=["General"],
         responses={"200": {"description": "OK"}})
def clear_notifications():
    state.notifications.clear()
    return jsonify({"ok": True})
