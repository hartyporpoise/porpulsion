"""
Registry pull-through proxy.

When registry_pull_enabled=True, porpulsion auto-creates a dedicated
system user (porpulsion-image-proxy) and a dockerconfigjson imagePullSecret
(porpulsion-image-proxy) pointing at this agent's /api/image-proxy endpoint.

The /api/image-proxy route is protected by the existing Basic auth guard and
proxies OCI Distribution API requests to the upstream registry.  The upstream
registry host is derived from the image path itself — containerd sends
/v2/<registry-host>/<name>/manifests/<ref> and we forward to <registry-host>.

Flow
────
1. Agent starts with registry_pull_enabled=True.
2. ensure_registry_setup() creates the system user + pull secret (idempotent).
3. Workloads that list porpulsion-image-proxy in imagePullSecrets will have
   the secret validated and mounted automatically by the executor.
4. containerd authenticates to /api/image-proxy using the system user creds.
5. The /api/image-proxy route strips the registry host from the path and
   proxies the OCI request to that host without additional credentials.
"""
import logging
import os

log = logging.getLogger("porpulsion.registry_proxy")

PULL_SECRET_NAME  = "porpulsion-image-proxy"
_REGISTRY_USER    = "porpulsion-image-proxy"


def ensure_registry_setup(namespace: str, self_url: str) -> bool:
    """
    Idempotently create the system registry user and imagePullSecret.
    Returns True if setup succeeded, False on error.
    Called at agent startup when registry_pull_enabled=True.
    """
    try:
        password = _ensure_registry_user(namespace)
        _ensure_pull_secret(namespace, self_url, password)
        return True
    except Exception as exc:
        log.warning("registry setup failed: %s", exc)
        return False


def _ensure_registry_user(namespace: str) -> str:
    """
    Create the porpulsion-image-proxy system user if it doesn't exist.
    Password is stored in plaintext in the users Secret alongside the hash
    so the pull secret can always be regenerated with the correct password.
    Returns the plaintext password.
    """
    import base64
    from porpulsion.routes.auth import _load_users, _save_users, _hash_password
    from porpulsion.notifications import add_notification

    users = _load_users()
    if _REGISTRY_USER in users and users[_REGISTRY_USER].get("password"):
        return users[_REGISTRY_USER]["password"]

    # Generate a new random password
    password = base64.urlsafe_b64encode(os.urandom(24)).decode().rstrip("=")
    users[_REGISTRY_USER] = {
        "hash":     _hash_password(password),
        "password": password,   # plaintext — needed to rebuild the pull secret
        "system":   True,       # marks this as a non-human system account
    }
    _save_users(users)
    log.info("Created registry system user %r", _REGISTRY_USER)
    add_notification(
        level="info",
        title="Registry proxy enabled",
        message=(
            f"System user '{_REGISTRY_USER}' created and imagePullSecret "
            f"'{PULL_SECRET_NAME}' generated. Workloads using the imagePullSecret"
            "will use this automatically."
        ),
    )
    return password


def _ensure_pull_secret(namespace: str, self_url: str, password: str) -> None:
    """Create or update the porpulsion-image-proxy dockerconfigjson Secret."""
    import base64, json
    from kubernetes import client as k8s_client
    from porpulsion.tls import _k8s_core_v1
    from porpulsion import state

    # Allow operators with split ingress (WS external, API internal) to override
    # just the API-facing URL for the pull secret server field.
    api_url = (state.settings.registry_api_url or "").strip().rstrip("/") or self_url.rstrip("/")
    # containerd/k3s resolves pull-secret credentials by bare hostname (no scheme).
    # The auths key must be "host" or "host:port", not "https://host".
    from urllib.parse import urlparse as _urlparse
    _parsed = _urlparse(api_url)
    server = _parsed.netloc or api_url  # "host" or "host:port"
    auth   = base64.b64encode(f"{_REGISTRY_USER}:{password}".encode()).decode()
    cfg    = {"auths": {server: {"username": _REGISTRY_USER, "password": password, "auth": auth}}}
    encoded = base64.b64encode(json.dumps(cfg).encode()).decode()

    core_v1 = _k8s_core_v1()
    secret = k8s_client.V1Secret(
        metadata=k8s_client.V1ObjectMeta(name=PULL_SECRET_NAME, namespace=namespace),
        type="kubernetes.io/dockerconfigjson",
        data={".dockerconfigjson": encoded},
    )
    try:
        core_v1.create_namespaced_secret(namespace, secret)
        log.info("Created imagePullSecret %s (server=%s)", PULL_SECRET_NAME, server)
    except k8s_client.ApiException as e:
        if e.status == 409:
            core_v1.replace_namespaced_secret(PULL_SECRET_NAME, namespace, secret)
            log.debug("Updated imagePullSecret %s (server=%s)", PULL_SECRET_NAME, server)
        else:
            raise


def teardown_registry_setup(namespace: str) -> None:
    """
    Remove the registry system user and pull secret.
    Called when registry_pull_enabled is turned off.
    """
    from porpulsion.routes.auth import _load_users, _save_users
    from porpulsion.tls import _k8s_core_v1
    from kubernetes import client as k8s_client
    from porpulsion.notifications import add_notification

    # Remove system user
    try:
        users = _load_users()
        if _REGISTRY_USER in users:
            users.pop(_REGISTRY_USER)
            _save_users(users)
            log.info("Removed registry system user %r", _REGISTRY_USER)
    except Exception as exc:
        log.warning("Could not remove registry user: %s", exc)

    # Delete pull secret
    try:
        core_v1 = _k8s_core_v1()
        core_v1.delete_namespaced_secret(PULL_SECRET_NAME, namespace)
        log.info("Deleted imagePullSecret %s", PULL_SECRET_NAME)
    except k8s_client.ApiException as e:
        if e.status != 404:
            log.warning("Could not delete imagePullSecret %s: %s", PULL_SECRET_NAME, e)
    except Exception as exc:
        log.warning("Could not delete imagePullSecret %s: %s", PULL_SECRET_NAME, exc)

    add_notification(
        level="info",
        title="Registry proxy disabled",
        message=(
            f"System user '{_REGISTRY_USER}' and imagePullSecret '{PULL_SECRET_NAME}' removed. "
            "Workloads using the imagePullSecretwill fail to pull until re-enabled."
        ),
    )
