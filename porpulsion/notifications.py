"""
In-app notification helpers.

Any backend module can call add_notification() to surface a persistent
notification under the bell icon in the UI. Import here is deferred to
avoid circular imports with state.py.
"""
import uuid
from datetime import datetime, timezone

_MAX = 50   # cap to prevent unbounded growth


def add_notification(level: str, title: str, message: str):
    """
    Append a notification to state.notifications.

    level: "info" | "warn" | "error"
    """
    from porpulsion import state
    n = {
        "id": uuid.uuid4().hex[:12],
        "level": level,
        "title": title,
        "message": message,
        "ts": datetime.now(timezone.utc).isoformat(),
        "ack": False,
    }
    state.notifications.insert(0, n)
    if len(state.notifications) > _MAX:
        state.notifications[:] = state.notifications[:_MAX]
