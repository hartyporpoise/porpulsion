import logging

from flask import Blueprint, request, jsonify

from porpulsion import state, tls

log = logging.getLogger("porpulsion.routes.settings")

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
        "registry_api_url",
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

    # If registry_api_url changed while the proxy is enabled, rebuild the pull secret
    if "registry_api_url" in data and state.settings.registry_pull_enabled:
        try:
            from porpulsion.k8s.registry_proxy import ensure_registry_setup
            ensure_registry_setup(state.NAMESPACE, state.SELF_URL)
        except Exception as _exc:
            log.warning("Could not rebuild pull secret after api_url change: %s", _exc)

    log.info("Settings updated: %s", state.settings.to_dict())
    tls.save_state_configmap(state.NAMESPACE, state.settings, state.pending_approval)
    return jsonify(state.settings.to_dict())
