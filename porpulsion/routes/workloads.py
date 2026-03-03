import logging
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify

from porpulsion import state, tls
from porpulsion.models import RemoteApp, RemoteAppSpec
from porpulsion.channel import get_channel
from porpulsion.k8s.executor import (
    run_workload, delete_workload, scale_workload, get_deployment_status, get_pod_logs,
    get_configmap_data, patch_configmap_data, patch_secret_data,
    rollout_restart,
)
from porpulsion.k8s.store import (
    create_remoteapp_cr, delete_remoteapp_cr,
    list_remoteapp_crs, list_executingapp_crs,
    delete_executingapp_cr, cr_to_dict, get_cr_by_app_id, get_ea_cr_by_app_id,
    patch_cr_volume_data,
)

log = logging.getLogger("porpulsion.routes.workloads")

bp = Blueprint("workloads", __name__)


# ── k8s quantity parser ────────────────────────────────────────
_MEMORY_SUFFIXES = {
    "ki": 2**10, "mi": 2**20, "gi": 2**30, "ti": 2**40,
    "k":  1e3,               "g":  1e9,   "t":  1e12,
}


def _parse_quantity(q: str) -> float:
    """
    Parse a Kubernetes quantity string into a normalised float.
    CPU: returns cores (e.g. "250m" → 0.25, "1" → 1.0).
    Memory: returns bytes (e.g. "64Mi" → 67108864, "1Gi" → 1073741824).
    Returns 0.0 for empty/None.
    """
    if not q:
        return 0.0
    q = str(q).strip()
    lower = q.lower()
    for suffix, factor in _MEMORY_SUFFIXES.items():
        if lower.endswith(suffix):
            return float(q[: -len(suffix)]) * factor
    if lower.endswith("m"):
        return float(q[:-1]) / 1000.0
    return float(q)


def _check_crd_compatibility(peer, spec_dict: dict) -> str | None:
    """
    Return an error string if the peer's CRD is missing fields that this spec uses,
    or None if everything is compatible.
    """
    diff = getattr(peer, "crd_diff", None)
    if not diff:
        return None
    missing_on_peer = diff.get("missing_remote", [])
    if not missing_on_peer:
        return None
    used_missing = [f for f in missing_on_peer if spec_dict.get(f) not in (None, [], {})]
    if used_missing:
        return (
            f"Peer '{peer.name}' has an older CRD that does not support: "
            f"{', '.join(used_missing)}. "
            "Please upgrade the remote agent before using these fields."
        )
    return None


def _check_image_policy(image: str) -> str | None:
    """Check image against allowed/blocked prefix lists. Returns error string or None."""
    s = state.settings

    blocked = [p.strip() for p in s.blocked_images.split(",") if p.strip()]
    for prefix in blocked:
        if image.startswith(prefix):
            return f"Image '{image}' is blocked by this cluster's policy"

    allowed = [p.strip() for p in s.allowed_images.split(",") if p.strip()]
    if allowed and not any(image.startswith(p) for p in allowed):
        return (f"Image '{image}' is not in this cluster's allowed image list "
                f"({', '.join(allowed)})")

    return None


def _check_resource_quota(spec: RemoteAppSpec, source_peer: str = "") -> str | None:
    s = state.settings
    res = spec.resources

    def _res_get(section: str, key: str, default: str = "") -> str:
        if not res:
            return default
        sec = getattr(res, section, None)
        if sec is None:
            return default
        return sec.get(key, default) if hasattr(sec, "get") else default

    if s.require_resource_requests:
        if not _res_get("requests", "cpu") or not _res_get("requests", "memory"):
            return "This cluster requires resource requests (resources.requests.cpu and resources.requests.memory)"
    if s.require_resource_limits:
        if not _res_get("limits", "cpu") or not _res_get("limits", "memory"):
            return "This cluster requires resource limits (resources.limits.cpu and resources.limits.memory)"

    req_cpu_req = _parse_quantity(_res_get("requests", "cpu"))
    req_cpu_lim = _parse_quantity(_res_get("limits", "cpu"))
    req_mem_req = _parse_quantity(_res_get("requests", "memory"))
    req_mem_lim = _parse_quantity(_res_get("limits", "memory"))
    req_replicas = spec.replicas

    allowed_peers = [p.strip() for p in s.allowed_source_peers.split(",") if p.strip()]
    if allowed_peers and source_peer and source_peer not in allowed_peers:
        return f"Peer '{source_peer}' is not permitted to submit workloads to this cluster"

    if spec.image:
        img_err = _check_image_policy(spec.image)
        if img_err:
            return img_err

    if s.max_cpu_request_per_pod:
        limit = _parse_quantity(s.max_cpu_request_per_pod)
        if req_cpu_req > limit:
            return (f"CPU request {_res_get('requests', 'cpu', '0')} exceeds per-pod limit "
                    f"of {s.max_cpu_request_per_pod}")
    if s.max_cpu_limit_per_pod:
        limit = _parse_quantity(s.max_cpu_limit_per_pod)
        if req_cpu_lim > limit:
            return (f"CPU limit {_res_get('limits', 'cpu', '0')} exceeds per-pod limit "
                    f"of {s.max_cpu_limit_per_pod}")
    if s.max_memory_request_per_pod:
        limit = _parse_quantity(s.max_memory_request_per_pod)
        if req_mem_req > limit:
            return (f"Memory request {_res_get('requests', 'memory', '0')} exceeds per-pod limit "
                    f"of {s.max_memory_request_per_pod}")
    if s.max_memory_limit_per_pod:
        limit = _parse_quantity(s.max_memory_limit_per_pod)
        if req_mem_lim > limit:
            return (f"Memory limit {_res_get('limits', 'memory', '0')} exceeds per-pod limit "
                    f"of {s.max_memory_limit_per_pod}")

    if s.max_replicas_per_app and req_replicas > s.max_replicas_per_app:
        return (f"Requested {req_replicas} replicas exceeds this cluster's per-app limit "
                f"of {s.max_replicas_per_app}")

    # Aggregate quota checks — query ExecutingApp CRs for current usage
    active_crs = [
        cr for cr in list_executingapp_crs(state.NAMESPACE)
        if (cr.get("status") or {}).get("phase") not in ("Failed", "Timeout", "Deleted")
    ]

    if s.max_total_deployments and len(active_crs) >= s.max_total_deployments:
        return (f"This cluster has reached its deployment limit "
                f"({s.max_total_deployments} concurrent RemoteApps)")

    def _cr_res_get(cr: dict, section: str, key: str) -> str:
        r = (cr.get("spec") or {}).get("resources") or {}
        sec = r.get(section) or {}
        return sec.get(key, "") if isinstance(sec, dict) else ""

    if s.max_total_pods:
        used_pods = sum(
            int((cr.get("spec") or {}).get("replicas") or 1)
            for cr in active_crs
        )
        if used_pods + req_replicas > s.max_total_pods:
            return (f"Insufficient pod capacity: {req_replicas} requested, "
                    f"{s.max_total_pods - used_pods} available "
                    f"(limit {s.max_total_pods} total pods)")

    if s.max_total_cpu_requests:
        max_total = _parse_quantity(s.max_total_cpu_requests)
        used = sum(_parse_quantity(_cr_res_get(cr, "requests", "cpu")) for cr in active_crs)
        if used + req_cpu_req > max_total:
            return (f"Insufficient CPU capacity: request {_res_get('requests', 'cpu', '0')} "
                    f"would exceed cluster total of {s.max_total_cpu_requests}")

    if s.max_total_memory_requests:
        max_total = _parse_quantity(s.max_total_memory_requests)
        used = sum(_parse_quantity(_cr_res_get(cr, "requests", "memory")) for cr in active_crs)
        if used + req_mem_req > max_total:
            return (f"Insufficient memory: request {_res_get('requests', 'memory', '0')} "
                    f"would exceed cluster total of {s.max_total_memory_requests}")

    return None


@bp.route("/remoteapp-spec")
def remoteapp_spec_schema():
    """Return the RemoteApp spec schema for the docs page, derived from schema.yaml."""
    from porpulsion.k8s.store import load_spec_schema
    _TYPE_NAMES = {"string": "string", "integer": "integer", "boolean": "boolean",
                   "number": "number", "array": "list", "object": "object"}
    _INTERNAL = {"targetPeer"}
    schema = load_spec_schema() or {}
    fields = []
    for field_name, prop in schema.items():
        if field_name in _INTERNAL:
            continue
        typ = _TYPE_NAMES.get(prop.get("type", ""), prop.get("type", ""))
        default_val = str(prop["default"]) if "default" in prop else ("required" if field_name == "image" else "—")
        fields.append({
            "field": field_name,
            "type": typ,
            "default": default_val,
            "description": prop.get("description", ""),
        })
    example = (
        "image: ghcr.io/myorg/api:v3.0\n"
        "replicas: 2\n"
        "ports:\n"
        "  - port: 8080\n"
        "    name: http\n"
        "resources:\n"
        "  requests:\n"
        "    cpu: 250m\n"
        "    memory: 256Mi\n"
        "  limits:\n"
        "    cpu: 500m\n"
        "    memory: 512Mi\n"
        "env:\n"
        "  - name: NODE_ENV\n"
        "    value: production\n"
    )
    return jsonify({"fields": fields, "example": example})


@bp.route("/remoteapp", methods=["POST"])
def create_remoteapp():
    data = request.json
    if not data or "name" not in data:
        return jsonify({"error": "name is required"}), 400
    if "spec_yaml" in data:
        import yaml as _yaml
        try:
            data["spec"] = _yaml.safe_load(data["spec_yaml"]) or {}
        except Exception as e:
            return jsonify({"error": f"invalid YAML: {e}"}), 400
    if not state.peers:
        return jsonify({"error": "no peers connected"}), 503

    target_peer_name = data.get("target_peer", "")

    def _create_and_forward(peer, spec_dict, app_name):
        compat_err = _check_crd_compatibility(peer, spec_dict)
        if compat_err:
            raise RuntimeError(compat_err)
        ra = RemoteApp(name=app_name, spec=RemoteAppSpec.from_dict(spec_dict),
                       source_peer=state.AGENT_NAME, target_peer=peer.name)
        cr_name = create_remoteapp_cr(
            state.NAMESPACE, ra.id, ra.name, spec_dict, peer.name,
            source_peer=state.AGENT_NAME,
        )
        if cr_name:
            ra.cr_name = cr_name
        ch = get_channel(peer.name)
        ch.call("remoteapp/receive", {
            "id": ra.id, "name": ra.name,
            "spec": ra.spec.to_dict(), "source_peer": state.AGENT_NAME,
        })
        log.info("Forwarded app %s (%s) to peer %s (cr=%s)", ra.name, ra.id, peer.name, cr_name or "none")
        return ra

    if target_peer_name == "*":
        peers_to_deploy = list(state.peers.values())
        if not peers_to_deploy:
            return jsonify({"error": "no peers connected"}), 503
        results = []
        for peer in peers_to_deploy:
            try:
                ra = _create_and_forward(peer, data.get("spec", {}), data["name"])
                results.append(ra.to_dict())
            except Exception as e:
                log.warning("Failed to forward app to peer %s: %s", peer.name, e)
        return jsonify({"deployed": results, "count": len(results)}), 201

    if target_peer_name:
        peer = state.peers.get(target_peer_name)
        if not peer:
            return jsonify({"error": f"peer '{target_peer_name}' not found or not connected"}), 400
    else:
        peer = next(iter(state.peers.values()))

    try:
        ra = _create_and_forward(peer, data.get("spec", {}), data["name"])
    except Exception as e:
        return jsonify({"error": f"failed to reach peer: {e}"}), 502

    return jsonify(ra.to_dict()), 201


@bp.route("/remoteapp/pending-approval")
def list_pending_approval():
    return jsonify(list(state.pending_approval.values()))


@bp.route("/remoteapp/<app_id>/approve", methods=["POST"])
def approve_remoteapp(app_id):
    if app_id not in state.pending_approval:
        return jsonify({"error": "not found"}), 404
    entry = state.pending_approval.pop(app_id)
    parsed_spec = RemoteAppSpec.from_dict(entry["spec"])
    source = state.peers.get(entry["source_peer"])
    ra = RemoteApp(
        name=entry["name"],
        spec=parsed_spec,
        source_peer=entry["source_peer"],
        id=app_id,
    )
    tls.save_state_configmap(state.NAMESPACE, state.settings, state.pending_approval)
    log.info("Approved app %s (%s) from %s", ra.name, ra.id, ra.source_peer)
    run_workload(ra, entry["callback_url"], peer=source)
    return jsonify({"ok": True})


@bp.route("/remoteapp/<app_id>/reject", methods=["POST"])
def reject_remoteapp(app_id):
    if app_id not in state.pending_approval:
        return jsonify({"error": "not found"}), 404
    entry = state.pending_approval.pop(app_id)
    log.info("Rejected app %s (%s) from %s", entry["name"], app_id, entry["source_peer"])
    tls.save_state_configmap(state.NAMESPACE, state.settings, state.pending_approval)
    try:
        ch = get_channel(entry["source_peer"])
        ch.push("remoteapp/status", {
            "id": app_id, "status": "Rejected",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        log.warning("Could not notify source of rejection: %s", e)
    return jsonify({"ok": True})


@bp.route("/remoteapps")
def list_remoteapps():
    submitted  = [cr_to_dict(cr, "submitted")  for cr in list_remoteapp_crs(state.NAMESPACE)]
    executing  = [cr_to_dict(cr, "executing")  for cr in list_executingapp_crs(state.NAMESPACE)]
    return jsonify({"submitted": submitted, "executing": executing})


@bp.route("/remoteapp/<app_id>", methods=["DELETE"])
def delete_remoteapp(app_id):
    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None:
        return jsonify({"error": "app not found"}), 404

    d = cr_to_dict(cr, side)
    cr_name = d["cr_name"]

    if side == "submitted":
        # Notify the executing peer to tear down the workload
        peer = state.peers.get(d["target_peer"]) or next(iter(state.peers.values()), None)
        if peer:
            try:
                get_channel(peer.name).call("remoteapp/delete", {"id": app_id})
            except Exception as e:
                log.warning("Failed to notify peer of deletion: %s", e)
        delete_remoteapp_cr(state.NAMESPACE, cr_name)
        return jsonify({"ok": True})

    if side == "executing":
        # Delete local workload and notify the source peer
        ra = RemoteApp(
            id=app_id, name=d["name"],
            spec=RemoteAppSpec.from_dict(d.get("spec", {})),
            source_peer=d["source_peer"],
        )
        delete_workload(ra)
        delete_executingapp_cr(state.NAMESPACE, cr_name)
        try:
            get_channel(d["source_peer"]).push("remoteapp/status", {
                "id": app_id, "status": "Deleted",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as exc:
            log.warning("Failed to notify source peer of deletion: %s", exc)
        return jsonify({"ok": True})

    return jsonify({"error": "app not found"}), 404


@bp.route("/remoteapp/<app_id>/scale", methods=["POST"])
def scale_remoteapp(app_id):
    data = request.json or {}
    replicas = data.get("replicas")
    if replicas is None:
        return jsonify({"error": "replicas is required"}), 400
    try:
        replicas = max(0, int(replicas))
    except (ValueError, TypeError):
        return jsonify({"error": "replicas must be an integer"}), 400

    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None:
        return jsonify({"error": "app not found"}), 404

    d = cr_to_dict(cr, side)

    if side == "submitted":
        peer = state.peers.get(d["target_peer"]) or next(iter(state.peers.values()), None)
        if not peer:
            return jsonify({"error": "peer not connected"}), 503
        try:
            get_channel(peer.name).call("remoteapp/scale", {"id": app_id, "replicas": replicas})
            return jsonify({"ok": True, "replicas": replicas})
        except Exception as e:
            return jsonify({"error": str(e)}), 502

    if side == "executing":
        ra = RemoteApp(
            id=app_id, name=d["name"],
            spec=RemoteAppSpec.from_dict(d.get("spec", {})),
            source_peer=d["source_peer"],
        )
        try:
            scale_workload(ra, replicas)
            return jsonify({"ok": True, "replicas": replicas})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    return jsonify({"error": "app not found"}), 404


@bp.route("/remoteapp/<app_id>/detail")
def remoteapp_detail(app_id):
    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None:
        return jsonify({"error": "app not found"}), 404

    d = cr_to_dict(cr, side)

    if side == "submitted":
        peer = state.peers.get(d["target_peer"]) or next(iter(state.peers.values()), None)
        if not peer:
            return jsonify({"error": "peer not connected", "app": d}), 200
        try:
            detail = get_channel(peer.name).call("remoteapp/detail", {"id": app_id})
        except Exception as e:
            detail = {"error": str(e)}
        import yaml as _yaml
        spec = dict(cr.get("spec", {}))
        spec.pop("targetPeer", None)
        resp = {"app": d, "k8s": detail, "cr": cr, "spec_yaml": _yaml.dump(spec, default_flow_style=False, allow_unicode=True)}
        return jsonify(resp)

    if side == "executing":
        ra = RemoteApp(
            id=app_id, name=d["name"],
            spec=RemoteAppSpec.from_dict(d.get("spec", {})),
            source_peer=d["source_peer"],
        )
        detail = get_deployment_status(ra)
        return jsonify({"app": d, "k8s": detail})

    return jsonify({"error": "app not found"}), 404


@bp.route("/remoteapp/<app_id>/logs")
def remoteapp_logs(app_id):
    tail = request.args.get("tail", default=200, type=int)
    tail = max(1, min(500, tail))
    pod_name = (request.args.get("pod") or "").strip() or None
    order = request.args.get("order") or "pod"

    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None:
        return jsonify({"error": "app not found", "lines": []}), 404

    d = cr_to_dict(cr, side)

    if side == "submitted":
        peer = state.peers.get(d["target_peer"]) or next(iter(state.peers.values()), None)
        if not peer:
            return jsonify({"error": "peer not connected", "lines": []}), 200
        try:
            result = get_channel(peer.name).call(
                "remoteapp/logs", {"id": app_id, "tail": tail, "pod": pod_name, "order": order},
            )
        except Exception as e:
            return jsonify({"error": str(e), "lines": []}), 502
        return jsonify(result)

    if side == "executing":
        ra = RemoteApp(
            id=app_id, name=d["name"],
            spec=RemoteAppSpec.from_dict(d.get("spec", {})),
            source_peer=d["source_peer"],
        )
        result = get_pod_logs(ra, tail=tail, pod_name=pod_name, order_by_time=(order == "time"))
        return jsonify(result)

    return jsonify({"error": "app not found", "lines": []}), 404


@bp.route("/remoteapp/<app_id>/spec", methods=["PUT"])
def update_remoteapp_spec(app_id):
    data = request.json or {}
    if "spec_yaml" in data:
        import yaml as _yaml
        try:
            data["spec"] = _yaml.safe_load(data["spec_yaml"]) or {}
        except Exception as e:
            return jsonify({"error": f"invalid YAML: {e}"}), 400
    new_spec = data.get("spec")
    if new_spec is None:
        return jsonify({"error": "spec is required"}), 400

    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None or side != "submitted":
        return jsonify({"error": "app not found"}), 404

    d = cr_to_dict(cr, side)
    peer = state.peers.get(d["target_peer"]) or next(iter(state.peers.values()), None)
    if not peer:
        return jsonify({"error": "peer not connected"}), 503

    compat_err = _check_crd_compatibility(peer, new_spec)
    if compat_err:
        return jsonify({"error": compat_err}), 422

    try:
        get_channel(peer.name).call("remoteapp/spec-update", {
            "id": app_id, "spec": new_spec,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    # Patch the RemoteApp CR spec with the updated spec
    create_remoteapp_cr(
        state.NAMESPACE, app_id, d["name"], new_spec, d["target_peer"],
        source_peer=d["source_peer"],
    )
    return jsonify(d)


# ── Config management routes ──────────────────────────────────────────────────

def _forward_config_patch(app_id, kind, name, data):
    """Forward a config patch to the peer that is executing the app."""
    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None or side != "submitted":
        raise RuntimeError("app not found")
    d = cr_to_dict(cr, side)
    peer = state.peers.get(d["target_peer"]) or next(iter(state.peers.values()), None)
    if not peer:
        raise RuntimeError("peer not connected")
    get_channel(peer.name).call("remoteapp/config-patch", {
        "id": app_id, "kind": kind, "name": name, "data": data,
    })


@bp.route("/remoteapp/<app_id>/config/configmap/<name>")
def get_app_configmap(app_id, name):
    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None:
        return jsonify({"error": "app not found"}), 404
    d = cr_to_dict(cr, side)
    if side == "submitted":
        # Read from local CR spec — kept in sync by patch_cr_volume_data on every save
        spec = d.get("spec", {})
        for cm in (spec.get("configMaps") or []):
            if cm.get("name") == name:
                return jsonify({"data": dict(cm.get("data") or {})})
        return jsonify({"data": {}})
    if side == "executing":
        try:
            data = get_configmap_data(app_id, name)
            return jsonify({"data": data})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "app not found"}), 404


@bp.route("/remoteapp/<app_id>/config/configmap/<name>", methods=["PATCH"])
def patch_app_configmap(app_id, name):
    data = (request.json or {}).get("data")
    if not isinstance(data, dict):
        return jsonify({"error": "data must be a key-value object"}), 400
    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None:
        return jsonify({"error": "app not found"}), 404
    d = cr_to_dict(cr, side)
    if side == "submitted":
        try:
            _forward_config_patch(app_id, "configmap", name, data)
            patch_cr_volume_data(state.NAMESPACE, app_id, "configmap", name, data)
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 502
    if side == "executing":
        ra = RemoteApp(
            id=app_id, name=d["name"],
            spec=RemoteAppSpec.from_dict(d.get("spec", {})),
            source_peer=d["source_peer"],
        )
        try:
            patch_configmap_data(app_id, name, data)
            patch_cr_volume_data(state.NAMESPACE, app_id, "configmap", name, data)
            rollout_restart(ra)
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "app not found"}), 404


@bp.route("/remoteapp/<app_id>/config/secret/<name>")
def get_app_secret(app_id, name):
    import base64 as _b64
    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None:
        return jsonify({"error": "app not found"}), 404
    # Secret values are always base64-encoded in the CR spec (both RemoteApp and ExecutingApp).
    # Decode to plaintext for the UI.
    spec = cr.get("spec", {})
    for sec in (spec.get("secrets") or []):
        if sec.get("name") == name:
            decoded = {}
            for k, v in (sec.get("data") or {}).items():
                if not isinstance(v, str):
                    decoded[k] = v
                    continue
                try:
                    decoded[k] = _b64.b64decode(v).decode()
                except Exception:
                    decoded[k] = v  # already plaintext (legacy CR)
            return jsonify({"data": decoded})
    return jsonify({"data": {}})


@bp.route("/remoteapp/<app_id>/config/secret/<name>", methods=["PATCH"])
def patch_app_secret(app_id, name):
    data = (request.json or {}).get("data")
    if not isinstance(data, dict):
        return jsonify({"error": "data must be a key-value object"}), 400
    cr, side = get_cr_by_app_id(state.NAMESPACE, app_id)
    if cr is None:
        return jsonify({"error": "app not found"}), 404
    d = cr_to_dict(cr, side)
    if side == "submitted":
        try:
            _forward_config_patch(app_id, "secret", name, data)
            patch_cr_volume_data(state.NAMESPACE, app_id, "secret", name, data)
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 502
    if side == "executing":
        ra = RemoteApp(
            id=app_id, name=d["name"],
            spec=RemoteAppSpec.from_dict(d.get("spec", {})),
            source_peer=d["source_peer"],
        )
        try:
            patch_secret_data(app_id, name, data)
            patch_cr_volume_data(state.NAMESPACE, app_id, "secret", name, data)
            rollout_restart(ra)
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "app not found"}), 404
