"""
Lightweight CSRF protection for browser-submitted HTML forms.

A per-session token is generated on first access and stored in the Flask session.
Forms include it as a hidden field (_csrf_token); the before_request hook validates
it for all POST requests to HTML routes (everything not under /api/ or /ws).

API routes (/api/*) are already protected by session auth or HTTP Basic Auth and
are consumed by the SPA via fetch() — no CSRF token needed there.
"""
import hashlib
import os

from flask import session, request, abort


_TOKEN_KEY = "_csrf_token"


def generate_token() -> str:
    """Return (and lazily create) the CSRF token for the current session."""
    if _TOKEN_KEY not in session:
        session[_TOKEN_KEY] = hashlib.sha256(os.urandom(32)).hexdigest()
    return session[_TOKEN_KEY]


def validate_token() -> None:
    """
    Called from before_request for HTML form POSTs.
    Aborts with 403 if the submitted token doesn't match the session token.
    """
    submitted = request.form.get(_TOKEN_KEY, "")
    expected  = session.get(_TOKEN_KEY, "")
    if not expected or not submitted or submitted != expected:
        abort(403)
