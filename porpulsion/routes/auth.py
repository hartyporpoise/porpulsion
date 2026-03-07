"""
Authentication routes - signup, login, logout.

Users are stored in the porpulsion-users Kubernetes Secret as a JSON object:
  { "username": { "hash": "<PBKDF2-SHA256 hash>" }, ... }

If the Secret does not exist (first boot), unauthenticated visitors are shown
the signup page to create the first account.  After that, additional users can
be created only by already-authenticated users.
"""
import base64
import json
import logging
import threading
import time
from collections import deque

from flask import (
    Blueprint,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

log = logging.getLogger("porpulsion.auth")

bp = Blueprint("auth", __name__)

_USERS_SECRET = "porpulsion-users"

# -- Login rate limiter
# Tracks failed login attempts per source IP.
# After _LOCKOUT_FAILURES failures within _RATE_WINDOW seconds the IP is
# locked out for _LOCKOUT_SECONDS seconds.

_RATE_LOCK = threading.Lock()
_RATE_WINDOW = 60          # sliding window in seconds
_LOCKOUT_FAILURES = 10     # max failures before lockout
_LOCKOUT_SECONDS = 300     # 5-minute lockout
_rate_failures: dict[str, deque] = {}   # ip -> deque of failure timestamps
_rate_lockout:  dict[str, float] = {}   # ip -> lockout-expiry timestamp


def _is_rate_limited(ip: str) -> bool:
    """Return True if the IP is currently locked out."""
    now = time.monotonic()
    with _RATE_LOCK:
        if ip in _rate_lockout:
            if now < _rate_lockout[ip]:
                return True
            del _rate_lockout[ip]
            _rate_failures.pop(ip, None)
    return False


def _record_failure(ip: str) -> None:
    """Record a failed login attempt; lock out the IP if the threshold is exceeded."""
    now = time.monotonic()
    with _RATE_LOCK:
        q = _rate_failures.setdefault(ip, deque())
        while q and now - q[0] > _RATE_WINDOW:
            q.popleft()
        q.append(now)
        if len(q) >= _LOCKOUT_FAILURES:
            _rate_lockout[ip] = now + _LOCKOUT_SECONDS
            _rate_failures.pop(ip, None)
            log.warning("Login rate limit: locking out %s for %ds", ip, _LOCKOUT_SECONDS)


def _clear_failures(ip: str) -> None:
    """Clear failure state after a successful login."""
    with _RATE_LOCK:
        _rate_failures.pop(ip, None)
        _rate_lockout.pop(ip, None)


# -- Kubernetes helpers


def _k8s_core_v1():
    from kubernetes import client, config as kube_config
    try:
        kube_config.load_incluster_config()
    except Exception:
        kube_config.load_kube_config()
    return client.CoreV1Api()


def _get_namespace() -> str:
    from porpulsion import state
    return state.NAMESPACE


class _LoadError(Exception):
    """Raised when the users Secret exists but could not be read."""


def _load_users() -> dict:
    """Return {username: {hash: ...}} from the k8s Secret.

    Returns {} when the Secret genuinely doesn't exist (first run).
    Raises _LoadError when the Secret exists but can't be read (permissions, etc.).
    """
    from kubernetes.client.rest import ApiException
    try:
        core_v1 = _k8s_core_v1()
        secret = core_v1.read_namespaced_secret(_USERS_SECRET, _get_namespace())
        raw = (secret.data or {}).get("users")
        if raw:
            return json.loads(base64.b64decode(raw).decode())
        return {}
    except ApiException as exc:
        if exc.status == 404:
            return {}  # Secret doesn't exist yet - genuine first run
        log.error("Could not read users secret (status %s): %s", exc.status, exc)
        raise _LoadError(str(exc)) from exc
    except Exception as exc:
        log.error("Could not load users secret: %s", exc)
        raise _LoadError(str(exc)) from exc


def _save_users(users: dict) -> None:
    """Persist the users dict back to the k8s Secret (sync)."""
    from kubernetes import client as k8s_client
    core_v1 = _k8s_core_v1()
    ns = _get_namespace()
    encoded = base64.b64encode(json.dumps(users).encode()).decode()
    secret = k8s_client.V1Secret(
        metadata=k8s_client.V1ObjectMeta(name=_USERS_SECRET, namespace=ns),
        data={"users": encoded},
    )
    try:
        core_v1.create_namespaced_secret(ns, secret)
    except k8s_client.ApiException as e:
        if e.status == 409:
            core_v1.patch_namespaced_secret(_USERS_SECRET, ns, secret)
        else:
            raise


def _hash_password(password: str) -> str:
    import hashlib, os
    salt = os.urandom(32)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 260_000)
    return base64.b64encode(salt + dk).decode()


def _verify_password(password: str, stored: str) -> bool:
    import hashlib, hmac
    raw = base64.b64decode(stored.encode())
    salt, dk = raw[:32], raw[32:]
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 260_000)
    return hmac.compare_digest(dk, check)


# -- Routes


@bp.route("/signup", methods=["GET", "POST"])
def signup():
    try:
        users = _load_users()
    except _LoadError:
        return render_template("auth/login.html", error="Could not reach the cluster - check permissions.")

    # If users already exist and this visitor is not logged in, go to login
    if users and not session.get("user"):
        return redirect(url_for("auth.login"))

    # If users exist and visitor IS logged in, this is "add user" mode
    adding = bool(users and session.get("user"))

    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        confirm  = request.form.get("confirm", "")

        if not username:
            error = "Username is required."
        elif not password:
            error = "Password is required."
        elif password != confirm:
            error = "Passwords do not match."
        elif len(password) < 8:
            error = "Password must be at least 8 characters."
        elif username in users:
            error = "Username already exists."
        else:
            users[username] = {"hash": _hash_password(password)}
            try:
                _save_users(users)
                log.info("User '%s' created", username)
                if not adding:
                    session["user"] = username
                    return redirect(url_for("ui.index"))
                else:
                    return redirect(url_for("auth.users"))
            except Exception as exc:
                log.error("Failed to save user: %s", exc)
                error = "Could not save user - check cluster permissions."

    return render_template("auth/signup.html", adding=adding, error=error, success=None)


@bp.route("/login", methods=["GET", "POST"])
def login():
    if session.get("user"):
        return redirect(url_for("ui.index"))

    try:
        users = _load_users()
    except _LoadError:
        return render_template("auth/login.html",
                               error="Could not reach the cluster - check permissions.")

    # No users yet -> first-run signup
    if not users:
        return redirect(url_for("auth.signup"))

    ip = request.remote_addr or "unknown"
    error = None
    if request.method == "POST":
        if _is_rate_limited(ip):
            error = "Too many failed attempts. Please try again later."
            return render_template("auth/login.html", error=error), 429

        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = users.get(username)
        if user and _verify_password(password, user["hash"]):
            _clear_failures(ip)
            session["user"] = username
            next_url = request.args.get("next") or url_for("ui.index")
            return redirect(next_url)
        _record_failure(ip)
        error = "Invalid username or password."

    return render_template("auth/login.html", error=error)


@bp.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("auth.login"))


def _render_users(all_users, error=None, add_error=None, edit_target=None, edit_error=None):
    return render_template("auth/users.html",
                           current_user=session.get("user", ""),
                           agent_name=_agent_name(),
                           usernames=sorted(all_users.keys()),
                           error=error,
                           add_error=add_error,
                           edit_target=edit_target,
                           edit_error=edit_error)


@bp.route("/users")
def users():
    if not session.get("user"):
        return redirect(url_for("auth.login", next="/users"))
    try:
        all_users = _load_users()
    except _LoadError:
        return _render_users({}, error="Could not load users - check cluster permissions.")
    return _render_users(all_users)


@bp.route("/users/add", methods=["POST"])
def users_add():
    if not session.get("user"):
        return redirect(url_for("auth.login"))
    try:
        all_users = _load_users()
    except _LoadError:
        return redirect(url_for("auth.users"))

    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    confirm  = request.form.get("confirm", "")
    error = None

    if not username:
        error = "Username is required."
    elif len(password) < 8:
        error = "Password must be at least 8 characters."
    elif password != confirm:
        error = "Passwords do not match."
    elif username in all_users:
        error = "Username already exists."

    if error:
        return _render_users(all_users, add_error=error)

    all_users[username] = {"hash": _hash_password(password)}
    try:
        _save_users(all_users)
        log.info("User '%s' added by '%s'", username, session["user"])
    except Exception as exc:
        log.error("Failed to save user: %s", exc)
    return redirect(url_for("auth.users"))


@bp.route("/users/edit", methods=["POST"])
def users_edit():
    if not session.get("user"):
        return redirect(url_for("auth.login"))
    try:
        all_users = _load_users()
    except _LoadError:
        return redirect(url_for("auth.users"))

    original  = request.form.get("original_username", "").strip()
    new_name  = request.form.get("username", "").strip()
    password  = request.form.get("password", "")
    confirm   = request.form.get("confirm", "")

    if not original or original not in all_users:
        return redirect(url_for("auth.users"))

    error = None
    if not new_name:
        error = "Username is required."
    elif new_name != original and new_name in all_users:
        error = "Username already exists."
    elif password and len(password) < 8:
        error = "Password must be at least 8 characters."
    elif password and password != confirm:
        error = "Passwords do not match."

    if error:
        return _render_users(all_users, edit_target=original, edit_error=error)

    entry = all_users.pop(original)
    if password:
        entry["hash"] = _hash_password(password)
    all_users[new_name] = entry

    try:
        _save_users(all_users)
        log.info("User '%s' edited (new name: '%s') by '%s'", original, new_name, session["user"])
    except Exception as exc:
        log.error("Failed to save user edit: %s", exc)
        return _render_users(all_users, edit_target=original, edit_error="Could not save - check cluster permissions.")

    # If the current user renamed themselves, update the session
    if original == session.get("user") and new_name != original:
        session["user"] = new_name

    return redirect(url_for("auth.users"))


@bp.route("/users/remove", methods=["POST"])
def users_remove():
    if not session.get("user"):
        return redirect(url_for("auth.login"))
    try:
        all_users = _load_users()
    except _LoadError:
        return redirect(url_for("auth.users"))

    target = request.form.get("username", "").strip()
    if not target:
        return redirect(url_for("auth.users"))
    if target == session.get("user"):
        # Don't let users delete themselves
        return redirect(url_for("auth.users"))

    all_users.pop(target, None)
    try:
        _save_users(all_users)
        log.info("User '%s' removed by '%s'", target, session["user"])
    except Exception as exc:
        log.error("Failed to save users after removal: %s", exc)
    return redirect(url_for("auth.users"))


def _agent_name() -> str:
    from porpulsion import state
    return state.AGENT_NAME
