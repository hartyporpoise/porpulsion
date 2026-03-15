"""
CR management for porpulsion.io/v1alpha1 RemoteApp and ExecutingApp custom resources.

RemoteApp CRs are created by the submitting side (local cluster).
ExecutingApp CRs are created by the receiving side (the peer that runs the workload).

Both CRDs share the same spec schema (charts/porpulsion/files/schema.yaml), baked
into the Docker image at build time. This is the single source of truth for spec
fields, types, and defaults - no k8s API call is needed to discover the schema.
"""
import base64 as _b64
import datetime
import logging
import pathlib
import threading

import yaml
from kubernetes import client, config
from kubernetes.client.rest import ApiException

log = logging.getLogger("porpulsion.crd")

GROUP   = "porpulsion.io"
VERSION = "v1alpha1"
PLURAL    = "remoteapps"
PLURAL_EA = "executingapps"

try:
    config.load_incluster_config()
except config.ConfigException:
    try:
        config.load_kube_config()
    except Exception:
        pass

_crd_api = client.CustomObjectsApi()

# CRD availability - checked lazily, separately for each plural
_crd_available: bool | None = None
_crd_lock = threading.Lock()

_ea_crd_available: bool | None = None
_ea_crd_lock = threading.Lock()

# schema.yaml path: charts/porpulsion/files/schema.yaml (baked into Docker image).
_SCHEMA_FILE = pathlib.Path(__file__).parent.parent.parent / "charts" / "porpulsion" / "files" / "schema.yaml"

# Cached spec schema: dict of property_name -> openAPIV3Schema property dict.
_spec_schema: dict | None = None
_spec_schema_loaded = False
_spec_schema_lock = threading.Lock()


def load_spec_schema() -> dict | None:
    """
    Load and cache the RemoteApp spec schema from schema.yaml (baked into the image).
    Called once at agent startup. Returns the property dict or None if unavailable.
    Subsequent calls return the cached value immediately - no I/O.
    """
    global _spec_schema, _spec_schema_loaded
    if _spec_schema_loaded:
        return _spec_schema
    with _spec_schema_lock:
        if _spec_schema_loaded:
            return _spec_schema
        try:
            _spec_schema = yaml.safe_load(_SCHEMA_FILE.read_text())
            log.info("Loaded RemoteApp spec schema from %s: %d fields",
                     _SCHEMA_FILE.name, len(_spec_schema or {}))
        except Exception as e:
            log.warning("Could not load schema.yaml (%s): %s - using passthrough mode",
                        _SCHEMA_FILE, e)
        _spec_schema_loaded = True
    return _spec_schema


def _check_crd_available(namespace: str) -> bool:
    global _crd_available
    if _crd_available is not None:
        return _crd_available
    with _crd_lock:
        if _crd_available is not None:
            return _crd_available
        try:
            _crd_api.list_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, limit=1)
            _crd_available = True
        except ApiException as e:
            if e.status == 404:
                # CRD genuinely absent — latch False permanently
                log.warning("RemoteApp CRD not available (status %s)  CR operations disabled", e.status)
                _crd_available = False
            else:
                # 403 = RBAC not yet granted, or any other transient error — retry on next call
                log.warning("RemoteApp CRD check transient error (status %s)  will retry", e.status)
        except Exception as e:
            log.warning("RemoteApp CRD check failed: %s  will retry", e)
    return bool(_crd_available)


def _check_ea_crd_available(namespace: str) -> bool:
    global _ea_crd_available
    if _ea_crd_available is not None:
        return _ea_crd_available
    with _ea_crd_lock:
        if _ea_crd_available is not None:
            return _ea_crd_available
        try:
            _crd_api.list_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA, limit=1)
            _ea_crd_available = True
        except ApiException as e:
            if e.status == 404:
                log.warning("ExecutingApp CRD not available (status %s)  EA CR operations disabled", e.status)
                _ea_crd_available = False
            else:
                # 403 = RBAC not yet granted — retry on next call
                log.warning("ExecutingApp CRD check transient error (status %s)  will retry", e.status)
        except Exception as e:
            log.warning("ExecutingApp CRD check failed: %s  will retry", e)
    return bool(_ea_crd_available)




def safe_resource_name(app_id: str, app_name: str) -> str:
    """
    Produce the sanitized k8s resource name used for Deployments, ConfigMaps, Secrets,
    and PVCs belonging to this app. Format: ea-{id}-{safe_name}.
    Exported so the executor can use it directly.
    """
    safe = "".join(c if c.isalnum() or c == "-" else "-" for c in app_name.lower()).strip("-")
    return f"ea-{app_id}-{safe}"[:63].rstrip("-")


def _cr_name(app_name: str) -> str:
    """Sanitize app_name to a valid k8s metadata.name for a RemoteApp CR."""
    safe = "".join(c if c.isalnum() or c == "-" else "-" for c in app_name.lower()).strip("-")
    return safe[:63].rstrip("-")


def remoteapp_name_exists(namespace: str, name: str) -> bool:
    """Return True if a RemoteApp CR with this metadata.name already exists."""
    if not _check_crd_available(namespace):
        return False
    try:
        _crd_api.get_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, _cr_name(name))
        return True
    except ApiException as e:
        if e.status == 404:
            return False
        return False  # on error, let create_remoteapp_cr handle it
    except Exception:
        return False


def _ea_cr_name(app_id: str, app_name: str) -> str:
    """Produce a valid k8s name for an ExecutingApp CR: ea-{id}-{safe_name}."""
    safe = "".join(c if c.isalnum() or c == "-" else "-" for c in app_name.lower()).strip("-")
    return f"ea-{app_id}-{safe}"[:63].rstrip("-")


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# -- CR -> dict conversion

def cr_to_dict(cr: dict, side: str) -> dict:
    """Convert a RemoteApp or ExecutingApp CR dict to the API response shape."""
    meta   = cr.get("metadata", {})
    ann    = meta.get("annotations", {})
    status = cr.get("status", {})
    spec   = dict(cr.get("spec", {}))
    target_peer = spec.pop("targetPeer", "")
    return {
        "id":            status.get("appId", ""),
        "name":          meta.get("name", ""),
        "spec":          spec,
        "source_peer":   status.get("sourcePeer", ""),
        "target_peer":   target_peer,
        "status":        status.get("phase", "Unknown"),
        "cr_name":       meta.get("name", ""),
        "resource_name": status.get("resourceName", ""),
        "side":          side,
        "created_at":    meta.get("creationTimestamp", ""),
        "updated_at":    status.get("updatedAt", status.get("lastUpdated", "")),
    }


def get_cr_by_app_id(namespace: str, app_id: str) -> tuple[dict | None, str]:
    """
    Find a RemoteApp or ExecutingApp CR by app-id.
    Checks status.appId and porpulsion.io/app-id label across both CR types.
    Returns (cr_dict, "submitted"|"executing") or (None, "").
    """
    # RemoteApp: scan only (user-owned CRs carry no porpulsion labels)
    try:
        result = _crd_api.list_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL)
        for item in result.get("items", []):
            if item.get("status", {}).get("appId") == app_id:
                return item, "submitted"
    except Exception:
        pass

    # ExecutingApp: label-selector fast path (agent-owned, always labelled)
    try:
        result = _crd_api.list_namespaced_custom_object(
            GROUP, VERSION, namespace, PLURAL_EA,
            label_selector=f"porpulsion.io/app-id={app_id}",
        )
        items = result.get("items", [])
        if items:
            return items[0], "executing"
    except Exception:
        pass
    # Fallback scan for ExecutingApp
    try:
        result = _crd_api.list_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA)
        for item in result.get("items", []):
            if item.get("status", {}).get("appId") == app_id:
                return item, "executing"
    except Exception:
        pass

    return None, ""


# -- RemoteApp CR operations

def validate_remoteapp_spec(namespace: str, app_id: str, app_name: str, spec_dict: dict, target_peer: str) -> str | None:
    """
    Dry-run a RemoteApp CR creation to validate spec_dict against the CRD schema.
    Returns None if valid (or CRD unavailable), or an error string if rejected.
    """
    if not _check_crd_available(namespace):
        return None

    cr_name = _cr_name(app_name)
    cr_spec = dict(spec_dict)
    cr_spec["targetPeer"] = target_peer

    body = {
        "apiVersion": f"{GROUP}/{VERSION}",
        "kind": "RemoteApp",
        "metadata": {"name": cr_name, "namespace": namespace},
        "spec": cr_spec,
    }
    try:
        _crd_api.create_namespaced_custom_object(
            GROUP, VERSION, namespace, PLURAL, body,
            dry_run="All",
        )
        return None
    except ApiException as e:
        if e.status == 422:
            try:
                import json as _json
                body_obj = _json.loads(e.body) if isinstance(e.body, str) else (e.body or {})
                msg = body_obj.get("message") or str(e)
            except Exception:
                msg = str(e)
            log.debug("CRD dry-run rejected spec for %s: %s", cr_name, msg)
            return msg
        log.debug("CRD dry-run skipped (non-422 error %s): %s", e.status, e)
        return None
    except Exception as e:
        log.debug("CRD dry-run skipped (unexpected): %s", e)
        return None


def create_remoteapp_cr(namespace: str, app_name: str, spec_dict: dict,
                        target_peer: str) -> str | None:
    """
    Create (or replace) a RemoteApp CR on the local cluster. Returns the CR name, or None if unavailable.
    spec_dict should already have secret data base64-encoded.
    No status is written here — kopf's on_remoteapp_created handler owns status bootstrapping.
    """
    if not _check_crd_available(namespace):
        return None

    cr_name = _cr_name(app_name)
    cr_spec = dict(spec_dict)
    cr_spec["targetPeer"] = target_peer

    body = {
        "apiVersion": f"{GROUP}/{VERSION}",
        "kind": "RemoteApp",
        "metadata": {
            "name": cr_name,
            "namespace": namespace,
        },
        "spec": cr_spec,
    }
    try:
        _crd_api.create_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, body)
        log.info("Created RemoteApp CR %s/%s", namespace, cr_name)
        return cr_name
    except ApiException as e:
        if e.status == 409:
            try:
                existing = _crd_api.get_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, cr_name)
                body["metadata"]["resourceVersion"] = existing["metadata"]["resourceVersion"]
                _crd_api.replace_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, cr_name, body)
                log.info("Replaced RemoteApp CR %s/%s", namespace, cr_name)
                return cr_name
            except Exception as e2:
                log.warning("Failed to replace RemoteApp CR %s: %s", cr_name, e2)
        else:
            log.warning("Failed to create RemoteApp CR %s: %s", cr_name, e)
    return None


def update_remoteapp_cr_status(namespace: str, cr_name: str, phase: str, app_id: str, message: str = "") -> None:
    """Patch the status subresource of a RemoteApp CR."""
    if not _check_crd_available(namespace):
        return
    _patch_status(namespace, PLURAL, cr_name, {
        "phase":       phase,
        "appId":       app_id,
        "message":   message,
        "updatedAt": _now_iso(),
    })


def delete_remoteapp_cr(namespace: str, cr_name: str) -> None:
    """Delete a RemoteApp CR."""
    if not _check_crd_available(namespace):
        return
    try:
        _crd_api.delete_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, cr_name)
        log.info("Deleted RemoteApp CR %s/%s", namespace, cr_name)
    except ApiException as e:
        if e.status != 404:
            log.warning("Failed to delete RemoteApp CR %s: %s", cr_name, e)


def get_remoteapp_cr(namespace: str, cr_name: str) -> dict | None:
    """Fetch a single RemoteApp CR. Returns the full object dict or None."""
    if not _check_crd_available(namespace):
        return None
    try:
        return _crd_api.get_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, cr_name)
    except ApiException as e:
        if e.status != 404:
            log.warning("Failed to get RemoteApp CR %s: %s", cr_name, e)
        return None


def list_remoteapp_crs(namespace: str) -> list[dict]:
    """List all RemoteApp CRs in namespace. Returns list of CR dicts."""
    if not _check_crd_available(namespace):
        return []
    try:
        result = _crd_api.list_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL)
        return result.get("items", [])
    except Exception as e:
        log.warning("Failed to list RemoteApp CRs: %s", e)
        return []


# -- ExecutingApp CR operations

def create_executingapp_cr(namespace: str, app_id: str, app_name: str, spec_dict: dict,
                           source_peer: str) -> str | None:
    """
    Create an ExecutingApp CR on the local cluster (receiving side).
    Returns the CR name, or None if CRD is unavailable.
    """
    if not _check_ea_crd_available(namespace):
        return None

    cr_name = _ea_cr_name(app_id, app_name)
    now = _now_iso()

    body = {
        "apiVersion": f"{GROUP}/{VERSION}",
        "kind": "ExecutingApp",
        "metadata": {
            "name": cr_name,
            "namespace": namespace,
            "labels": {
                "porpulsion.io/app-id":     app_id,
                "porpulsion.io/source-peer": source_peer,
            },
        },
        "spec": dict(spec_dict),
    }
    try:
        _crd_api.create_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA, body)
        log.info("Created ExecutingApp CR %s/%s", namespace, cr_name)
        _patch_status(namespace, PLURAL_EA, cr_name, {
            "phase":        "Pending",
            "appId":        app_id,
            "sourcePeer":   source_peer,
            "resourceName": safe_resource_name(app_id, app_name),
            "updatedAt":    now,
        })
        return cr_name
    except ApiException as e:
        if e.status == 409:
            try:
                existing = _crd_api.get_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA, cr_name)
                body["metadata"]["resourceVersion"] = existing["metadata"]["resourceVersion"]
                _crd_api.replace_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA, cr_name, body)
                log.info("Replaced ExecutingApp CR %s/%s", namespace, cr_name)
                return cr_name
            except Exception as e2:
                log.warning("Failed to replace ExecutingApp CR %s: %s", cr_name, e2)
        else:
            log.warning("Failed to create ExecutingApp CR %s: %s", cr_name, e)
    return None


def patch_executingapp_spec(namespace: str, cr_name: str, spec_dict: dict) -> bool:
    """Patch the spec of an existing ExecutingApp CR. Returns True on success."""
    if not _check_ea_crd_available(namespace):
        return False
    try:
        patch = {"spec": dict(spec_dict)}
        _crd_api.patch_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA, cr_name, patch)
        _patch_status(namespace, PLURAL_EA, cr_name, {"updatedAt": _now_iso()})
        log.info("Patched ExecutingApp CR spec %s/%s", namespace, cr_name)
        return True
    except ApiException as e:
        log.warning("Failed to patch ExecutingApp CR spec %s: %s", cr_name, e)
        return False


def update_executingapp_cr_status(namespace: str, cr_name: str, phase: str, app_id: str, message: str = "") -> None:
    """Patch the status subresource of an ExecutingApp CR."""
    if not _check_ea_crd_available(namespace):
        return
    _patch_status(namespace, PLURAL_EA, cr_name, {
        "phase":       phase,
        "appId":       app_id,
        "message":   message,
        "updatedAt": _now_iso(),
    })


def delete_executingapp_cr(namespace: str, cr_name: str) -> None:
    """Delete an ExecutingApp CR."""
    if not _check_ea_crd_available(namespace):
        return
    try:
        _crd_api.delete_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA, cr_name)
        log.info("Deleted ExecutingApp CR %s/%s", namespace, cr_name)
    except ApiException as e:
        if e.status != 404:
            log.warning("Failed to delete ExecutingApp CR %s: %s", cr_name, e)


def get_executingapp_cr(namespace: str, cr_name: str) -> dict | None:
    """Fetch a single ExecutingApp CR. Returns the full object dict or None."""
    if not _check_ea_crd_available(namespace):
        return None
    try:
        return _crd_api.get_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA, cr_name)
    except ApiException as e:
        if e.status != 404:
            log.warning("Failed to get ExecutingApp CR %s: %s", cr_name, e)
        return None


def list_executingapp_crs(namespace: str) -> list[dict]:
    """List all ExecutingApp CRs in namespace. Returns list of CR dicts."""
    if not _check_ea_crd_available(namespace):
        return []
    try:
        result = _crd_api.list_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA)
        return result.get("items", [])
    except Exception as e:
        log.warning("Failed to list ExecutingApp CRs: %s", e)
        return []


def get_ea_cr_by_app_id(namespace: str, app_id: str) -> dict | None:
    """Find an ExecutingApp CR by app-id. Returns the CR dict or None."""
    if not _check_ea_crd_available(namespace):
        return None
    try:
        result = _crd_api.list_namespaced_custom_object(
            GROUP, VERSION, namespace, PLURAL_EA,
            label_selector=f"porpulsion.io/app-id={app_id}",
        )
        items = result.get("items", [])
        if items:
            return items[0]
    except Exception as e:
        log.warning("Failed to get ExecutingApp CR by app-id %s: %s", app_id, e)
    try:
        result = _crd_api.list_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA)
        for item in result.get("items", []):
            if item.get("status", {}).get("appId") == app_id:
                return item
    except Exception as e:
        log.warning("Failed to scan ExecutingApp CRs for app-id %s: %s", app_id, e)
    return None


def patch_cr_volume_data(namespace: str, app_id: str, kind: str, vol_name: str,
                          data: dict) -> None:
    """
    Update the spec.configMaps[i].data or spec.secrets[i].data for a named
    volume entry in the CR (RemoteApp or ExecutingApp), keeping the CR in sync
    with live k8s ConfigMap/Secret state.

    kind: "configmap" or "secret"
    data: plaintext key->value dict. ConfigMap values stored as-is; secret
          values are base64-encoded in the CR (decoded by executor on apply).
    """
    # Find the CR - could be either type
    plural, cr = None, None
    ea = get_ea_cr_by_app_id(namespace, app_id)
    if ea is not None:
        plural, cr = PLURAL_EA, ea
    else:
        for item in list_remoteapp_crs(namespace):
            if item.get("status", {}).get("appId") == app_id:
                plural, cr = PLURAL, item
                break
    if cr is None or plural is None:
        log.warning("patch_cr_volume_data: CR not found for app_id=%s", app_id)
        return

    cr_name = cr["metadata"]["name"]
    spec = dict(cr.get("spec", {}))

    field = "configMaps" if kind == "configmap" else "secrets"
    entries = list(spec.get(field, []) or [])

    # Base64-encode secret values for storage in the CR spec
    stored_data = dict(data)
    if kind == "secret":
        stored_data = {k: _b64.b64encode(v.encode()).decode() if isinstance(v, str) else v
                       for k, v in data.items()}

    matched = False
    for i, entry in enumerate(entries):
        entry_name = entry.get("name") if isinstance(entry, dict) else getattr(entry, "name", None)
        if entry_name == vol_name:
            updated = dict(entry) if isinstance(entry, dict) else entry.to_dict()
            updated["data"] = stored_data
            entries[i] = updated
            matched = True
            break
    if not matched:
        log.warning("patch_cr_volume_data: volume %s not found in CR spec for app_id=%s", vol_name, app_id)
        return

    spec[field] = entries
    try:
        existing = _crd_api.get_namespaced_custom_object(GROUP, VERSION, namespace, plural, cr_name)
        body = dict(existing)
        body["spec"] = spec
        _crd_api.replace_namespaced_custom_object(GROUP, VERSION, namespace, plural, cr_name, body)
        log.info("Updated CR %s spec.%s[%s].data", cr_name, field, vol_name)
    except ApiException as e:
        log.warning("Failed to patch CR spec for %s: %s", cr_name, e)


# -- Internal helpers

def _patch_status(namespace: str, plural: str, cr_name: str, status_fields: dict) -> None:
    """Patch the status subresource of a CR (best-effort)."""
    body = {"status": status_fields}
    try:
        _crd_api.patch_namespaced_custom_object_status(GROUP, VERSION, namespace, plural, cr_name, body)
        log.debug("Patched %s/%s status -> %s", plural, cr_name, status_fields.get("phase", "?"))
    except ApiException as e:
        log.warning("Failed to patch %s/%s status: %s", plural, cr_name, e)


# -- Schema helpers

def get_spec_properties() -> dict | None:
    """Return spec property names from the baked-in schema.yaml."""
    return load_spec_schema()


def compare_spec_schemas(local_props: dict, remote_props: dict) -> dict:
    """
    Compare two sets of spec property names.
    Returns {"missing_local": [...], "missing_remote": [...]}.
    """
    _INTERNAL = {"targetPeer"}
    local_keys  = set(local_props or {}) - _INTERNAL
    remote_keys = set(remote_props or {}) - _INTERNAL
    return {
        "missing_local":  sorted(remote_keys - local_keys),
        "missing_remote": sorted(local_keys  - remote_keys),
    }


def bootstrap_cr_status(namespace: str, plural: str, cr_name: str,
                        existing_status: dict) -> str | None:
    """
    For CRs that have no status.appId (e.g. manually kubectl-applied), generate
    a fresh app-id and write it to status. Returns the app_id if bootstrapped,
    or None if already set.
    Called from kopf on.create handlers.
    """
    import uuid as _uuid

    if existing_status.get("appId"):
        return None  # already set

    app_id = _uuid.uuid4().hex[:8]
    log.info("Bootstrapping status for CR %s with generated app-id=%s", cr_name, app_id)
    status_patch = {
        "phase":    "Pending",
        "appId":    app_id,
        "updatedAt": _now_iso(),
    }
    if plural == PLURAL_EA:
        status_patch["resourceName"] = safe_resource_name(app_id, cr_name)
    _patch_status(namespace, plural, cr_name, status_patch)
    return app_id
