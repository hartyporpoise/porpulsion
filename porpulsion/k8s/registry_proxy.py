"""
Registry pull-through proxy.

When registry_pull_enabled=True, porpulsion auto-creates a dedicated
system user (porpulsion-registry) and a dockerconfigjson imagePullSecret
(porpulsion-image-proxy) pointing at this agent's /api/image-proxy endpoint.

The /api/image-proxy route is protected by the existing Basic auth guard and
proxies OCI Distribution API requests to the upstream private registry using
the credentials stored in the first porpulsion-reg-* Secret.

Flow
────
1. Agent starts with registry_pull_enabled=True.
2. ensure_registry_setup() creates the system user + pull secret (idempotent).
3. Executor sees registryProxy=true on a workload and appends
   PULL_SECRET_NAME to imagePullSecrets.
4. containerd authenticates to /api/image-proxy using the system user creds.
5. The /api/image-proxy route proxies to the upstream registry.
"""
import logging
import os

log = logging.getLogger("porpulsion.registry_proxy")

PULL_SECRET_NAME  = "porpulsion-image-proxy"
_REGISTRY_USER    = "porpulsion-registry"


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
    Create the porpulsion-registry system user if it doesn't exist.
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
            f"'{PULL_SECRET_NAME}' generated. Workloads with registryProxy=true "
            "will use this automatically."
        ),
    )
    return password


def _ensure_pull_secret(namespace: str, self_url: str, password: str) -> None:
    """Create or update the porpulsion-image-proxy dockerconfigjson Secret."""
    import base64, json
    from kubernetes import client as k8s_client
    from porpulsion.tls import _k8s_core_v1

    server = self_url.rstrip("/") + "/api/image-proxy"
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
        log.info("Created imagePullSecret %s", PULL_SECRET_NAME)
    except k8s_client.ApiException as e:
        if e.status == 409:
            core_v1.replace_namespaced_secret(PULL_SECRET_NAME, namespace, secret)
            log.debug("Updated imagePullSecret %s", PULL_SECRET_NAME)
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
            "Workloads with registryProxy=true will fail to pull until re-enabled."
        ),
    )


def get_upstream_registry() -> tuple[str, str]:
    """
    Return (host, 'user:password') for the first porpulsion-reg-* Secret, or ('', '').
    host is the upstream registry hostname (e.g. 'registry.example.com').
    Used by the /api/image-proxy route to know where to forward requests.
    """
    import base64, json
    from porpulsion import state
    from porpulsion.tls import _k8s_core_v1

    try:
        core_v1 = _k8s_core_v1()
        secrets = core_v1.list_namespaced_secret(
            state.NAMESPACE,
            label_selector="porpulsion.io/registry-secret=true",
        )
        for s in secrets.items:
            labels = (s.metadata.labels or {})
            host = labels.get("porpulsion.io/registry-server", "").replace("https://", "").rstrip("/")
            raw = (s.data or {}).get(".dockerconfigjson", "")
            if not raw:
                continue
            cfg = json.loads(base64.b64decode(raw).decode())
            for _, auth_data in cfg.get("auths", {}).items():
                uname = auth_data.get("username", "")
                pwd   = auth_data.get("password", "")
                if uname and pwd:
                    return host, f"{uname}:{pwd}"
                raw_auth = auth_data.get("auth", "")
                if raw_auth:
                    return host, base64.b64decode(raw_auth).decode()
    except Exception as exc:
        log.warning("Could not load upstream registry credentials: %s", exc)
    return "", ""
