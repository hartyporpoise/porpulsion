import base64
import json
import logging

from flask import Blueprint, request, jsonify

from porpulsion import state, tls

log = logging.getLogger("porpulsion.routes.settings")

_REGISTRY_SECRET_PREFIX = "porpulsion-reg-"

bp = Blueprint("settings", __name__)


def _apply_log_level(level_name: str):
    level = getattr(logging, level_name.upper(), logging.INFO)
    logging.getLogger().setLevel(level)


@bp.route("/settings")
def get_settings():
    return jsonify(state.settings.to_dict())


@bp.route("/settings", methods=["POST"])
def update_settings():
    data = request.json or {}
    valid_modes = ("manual", "auto", "per_peer")

    if "tunnel_approval_mode" in data:
        mode = data["tunnel_approval_mode"]
        if mode not in valid_modes:
            return jsonify({"error": f"tunnel_approval_mode must be one of {valid_modes}"}), 400
        state.settings.tunnel_approval_mode = mode

    if "allow_inbound_remoteapps" in data:
        state.settings.allow_inbound_remoteapps = bool(data["allow_inbound_remoteapps"])

    if "allow_inbound_tunnels" in data:
        state.settings.allow_inbound_tunnels = bool(data["allow_inbound_tunnels"])

    if "log_level" in data:
        level = data["log_level"].upper()
        if level not in ("DEBUG", "INFO", "WARNING", "ERROR"):
            return jsonify({"error": "log_level must be DEBUG, INFO, WARNING, or ERROR"}), 400
        state.settings.log_level = level
        _apply_log_level(level)

    bool_fields = (
        "require_remoteapp_approval", "require_resource_requests",
        "require_resource_limits", "allow_pvcs", "registry_pull_enabled",
    )
    for fld in bool_fields:
        if fld in data:
            setattr(state.settings, fld, bool(data[fld]))

    # React to registry_pull_enabled toggle immediately (no restart needed)
    if "registry_pull_enabled" in data:
        if data["registry_pull_enabled"]:
            try:
                from porpulsion.k8s.registry_proxy import ensure_registry_setup
                ensure_registry_setup(state.NAMESPACE, state.SELF_URL)
            except Exception as _exc:
                log.warning("Could not set up registry proxy: %s", _exc)
        else:
            try:
                from porpulsion.k8s.registry_proxy import teardown_registry_setup
                teardown_registry_setup(state.NAMESPACE)
            except Exception as _exc:
                log.warning("Could not tear down registry proxy: %s", _exc)

    str_fields = (
        "allowed_images", "blocked_images", "allowed_source_peers", "allowed_tunnel_peers",
        "max_cpu_request_per_pod", "max_cpu_limit_per_pod",
        "max_memory_request_per_pod", "max_memory_limit_per_pod",
        "max_total_cpu_requests", "max_total_memory_requests",
    )
    for fld in str_fields:
        if fld in data:
            setattr(state.settings, fld, str(data[fld]).strip())

    int_fields = ("max_replicas_per_app", "max_total_deployments", "max_total_pods",
                  "max_pvc_storage_per_pvc_gb", "max_pvc_storage_total_gb")
    for fld in int_fields:
        if fld in data:
            try:
                setattr(state.settings, fld, max(0, int(data[fld])))
            except (ValueError, TypeError):
                return jsonify({"error": f"{fld} must be an integer"}), 400

    log.info("Settings updated: %s", state.settings.to_dict())
    tls.save_state_configmap(state.NAMESPACE, state.settings, state.pending_approval)
    return jsonify(state.settings.to_dict())


# -- Registry credential management
#
# Each registry credential set is stored as a kubernetes.io/dockerconfigjson
# Secret named "porpulsion-reg-<name>" in the agent's namespace. The API
# exposes CRUD so the UI can manage them without kubectl.

def _k8s_core():
    from kubernetes import client as _k8s, config as _kube_config
    try:
        _kube_config.load_incluster_config()
    except Exception:
        _kube_config.load_kube_config()
    return _k8s.CoreV1Api()


def _build_dockerconfig(server: str, username: str, password: str) -> str:
    auth = base64.b64encode(f"{username}:{password}".encode()).decode()
    cfg = {"auths": {server: {"username": username, "password": password, "auth": auth}}}
    return base64.b64encode(json.dumps(cfg).encode()).decode()


@bp.route("/registry-secrets")
def list_registry_secrets():
    """List all porpulsion-managed registry credential Secrets."""
    core = _k8s_core()
    try:
        secrets = core.list_namespaced_secret(
            state.NAMESPACE,
            label_selector="porpulsion.io/registry-secret=true",
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    result = []
    for s in secrets.items:
        labels = s.metadata.labels or {}
        server = labels.get("porpulsion.io/registry-server", "")
        # Decode password from dockerconfigjson
        password = ""
        try:
            raw = (s.data or {}).get(".dockerconfigjson", "")
            if raw:
                import base64 as _b64, json as _json
                cfg = _json.loads(_b64.b64decode(raw).decode())
                password = cfg.get("auths", {}).get(server, {}).get("password", "")
        except Exception:
            pass
        result.append({
            "name":     s.metadata.name,
            "label":    labels.get("porpulsion.io/registry-label", s.metadata.name),
            "server":   server,
            "username": labels.get("porpulsion.io/registry-username", ""),
            "password": password,
        })
    return jsonify(result)


@bp.route("/registry-secrets", methods=["POST"])
def create_registry_secret():
    """Create a new docker-registry Secret for a private registry."""
    from kubernetes import client as _k8s
    data = request.json or {}
    label    = (data.get("label") or "").strip()
    server   = (data.get("server") or "").strip()
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()

    if not label or not server or not username:
        return jsonify({"error": "label, server, and username are required"}), 400

    # Derive a stable k8s-safe name from the label
    import re
    safe = re.sub(r"[^a-z0-9-]", "-", label.lower())[:40].strip("-")
    secret_name = f"{_REGISTRY_SECRET_PREFIX}{safe}"

    core = _k8s_core()

    # If no password supplied, fetch the existing one (edit without password change)
    if not password:
        try:
            existing = core.get_namespaced_secret(secret_name, state.NAMESPACE)
            import base64 as _b64, json as _json
            raw = existing.data.get(".dockerconfigjson", "")
            cfg = _json.loads(_b64.b64decode(raw).decode())
            password = cfg.get("auths", {}).get(server, {}).get("password", "")
        except Exception:
            return jsonify({"error": "password is required for new credentials"}), 400

    secret = _k8s.V1Secret(
        metadata=_k8s.V1ObjectMeta(
            name=secret_name,
            namespace=state.NAMESPACE,
            labels={
                "porpulsion.io/registry-secret":   "true",
                "porpulsion.io/registry-label":    label,
                "porpulsion.io/registry-server":   server,
                "porpulsion.io/registry-username": username,
            },
        ),
        type="kubernetes.io/dockerconfigjson",
        data={".dockerconfigjson": _build_dockerconfig(server, username, password)},
    )
    try:
        core.create_namespaced_secret(state.NAMESPACE, secret)
    except _k8s.ApiException as exc:
        if exc.status == 409:
            core.patch_namespaced_secret(secret_name, state.NAMESPACE, secret)
        else:
            return jsonify({"error": str(exc)}), 500

    log.info("Registry secret %r created/updated for server %s", secret_name, server)
    return jsonify({"ok": True, "name": secret_name, "label": label, "server": server})


@bp.route("/registry-secrets/<secret_name>", methods=["DELETE"])
def delete_registry_secret(secret_name):
    """Delete a porpulsion-managed registry credential Secret."""
    from kubernetes import client as _k8s
    if not secret_name.startswith(_REGISTRY_SECRET_PREFIX):
        return jsonify({"error": "not a porpulsion registry secret"}), 400
    core = _k8s_core()
    try:
        core.delete_namespaced_secret(secret_name, state.NAMESPACE)
    except _k8s.ApiException as exc:
        if exc.status == 404:
            return jsonify({"error": "not found"}), 404
        return jsonify({"error": str(exc)}), 500
    log.info("Registry secret %r deleted", secret_name)
    return jsonify({"ok": True})
