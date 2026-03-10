import logging

from flask import Blueprint, jsonify

from porpulsion import state

log = logging.getLogger("porpulsion.routes.notifications")

bp = Blueprint("notifications", __name__)


@bp.route("/notifications")
def list_notifications():
    return jsonify(state.notifications)


@bp.route("/notifications/<notif_id>/ack", methods=["POST"])
def ack_notification(notif_id):
    for n in state.notifications:
        if n["id"] == notif_id:
            n["ack"] = True
            return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


@bp.route("/notifications/<notif_id>", methods=["DELETE"])
def delete_notification(notif_id):
    before = len(state.notifications)
    state.notifications[:] = [n for n in state.notifications if n["id"] != notif_id]
    return jsonify({"ok": len(state.notifications) < before})


@bp.route("/notifications", methods=["DELETE"])
def clear_notifications():
    state.notifications.clear()
    return jsonify({"ok": True})
