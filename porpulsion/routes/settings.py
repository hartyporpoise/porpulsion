import logging

from flask import Blueprint, request, jsonify

from porpulsion import state, tls
from porpulsion.openapi_spec import api_doc, REF_SETTINGS

log = logging.getLogger("porpulsion.routes.settings")

bp = Blueprint("settings", __name__)


def _apply_log_level(level_name: str):
    level = getattr(logging, level_name.upper(), logging.INFO)
    logging.getLogger().setLevel(level)


@bp.route("/settings")
@api_doc("Get settings", tags=["Settings"],
         description="Current agent settings (approval mode, limits, image policy, etc.).",
         responses={"200": {"description": "OK", "content": {"application/json": {"schema": REF_SETTINGS}}}})
def get_settings():
    from urllib.parse import urlparse
    d = state.settings.to_dict()
    d["namespace"] = state.NAMESPACE
    parsed = urlparse(state.API_URL)
    d["proxy_domain"] = parsed.netloc or ""
    return jsonify(d)


@bp.route("/settings", methods=["POST"])
@api_doc("Update settings", tags=["Settings"],
         description="Update one or more settings. Persisted to ConfigMap.",
         request_body={"content": {"application/json": {"schema": REF_SETTINGS}}},
         responses={"200": {"description": "OK", "content": {"application/json": {"schema": REF_SETTINGS}}},
                    "400": {"description": "Validation error"}})
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
                ensure_registry_setup(state.NAMESPACE)
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
    _push_info_to_peers()
    return jsonify(state.settings.to_dict())


def _push_info_to_peers():
    """Push current agent info to all connected peers via peer/info-update."""
    try:
        from porpulsion.channel import get_channel
        proxy_url = state.registry_proxy_url()
        for peer_name in list(state.peer_channels.keys()):
            try:
                get_channel(peer_name, wait=0).push("peer/info-update", {
                    "name":               state.AGENT_NAME,
                    "registry_proxy_url": proxy_url,
                    "api_url":            state.API_URL,
                })
            except Exception as exc:
                log.debug("Could not push info-update to %s: %s", peer_name, exc)
    except Exception as exc:
        log.debug("_push_info_to_peers failed: %s", exc)
