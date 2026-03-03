"""
CR management for porpulsion.io/v1alpha1 RemoteApp and ExecutingApp custom resources.

RemoteApp CRs are created by the submitting side (local cluster).
ExecutingApp CRs are created by the receiving side (the peer that runs the workload).

Both CRDs share the same spec schema (charts/porpulsion/files/schema.yaml), baked
into the Docker image at build time. This is the single source of truth for spec
fields, types, and defaults — no k8s API call is needed to discover the schema.
"""
import datetime
import logging
import pathlib
import threading
import time

import yaml
from kubernetes import client, config, watch
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

# CRD availability — checked lazily, separately for each plural
_crd_available: bool | None = None
_crd_lock = threading.Lock()

_ea_crd_available: bool | None = None
_ea_crd_lock = threading.Lock()

# schema.yaml path: charts/porpulsion/files/schema.yaml (baked into Docker image).
_SCHEMA_FILE = pathlib.Path(__file__).parent.parent.parent / "charts" / "porpulsion" / "files" / "schema.yaml"

# Cached spec schema: dict of property_name → openAPIV3Schema property dict.
_spec_schema: dict | None = None
_spec_schema_loaded = False
_spec_schema_lock = threading.Lock()


def load_spec_schema() -> dict | None:
    """
    Load and cache the RemoteApp spec schema from schema.yaml (baked into the image).
    Called once at agent startup. Returns the property dict or None if unavailable.
    Subsequent calls return the cached value immediately — no I/O.
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
            log.warning("Could not load schema.yaml (%s): %s — using passthrough mode",
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
            if e.status in (404, 403):
                log.warning("RemoteApp CRD not available (status %s) — CR operations disabled", e.status)
                _crd_available = False
            else:
                _crd_available = False
        except Exception as e:
            log.warning("CRD check failed: %s", e)
            _crd_available = False
    return _crd_available


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
            if e.status in (404, 403):
                log.warning("ExecutingApp CRD not available (status %s) — EA CR operations disabled", e.status)
                _ea_crd_available = False
            else:
                _ea_crd_available = False
        except Exception as e:
            log.warning("ExecutingApp CRD check failed: %s", e)
            _ea_crd_available = False
    return _ea_crd_available


def _cr_name(app_id: str, app_name: str) -> str:
    """Produce a valid k8s name for a RemoteApp CR: ra-{id}-{safe_name}."""
    safe_name = "".join(c if c.isalnum() or c == "-" else "-" for c in app_name.lower()).strip("-")
    return f"ra-{app_id}-{safe_name}"[:63].rstrip("-")


def _ea_cr_name(app_id: str, app_name: str) -> str:
    """Produce a valid k8s name for an ExecutingApp CR: ea-{id}-{safe_name}."""
    safe_name = "".join(c if c.isalnum() or c == "-" else "-" for c in app_name.lower()).strip("-")
    return f"ea-{app_id}-{safe_name}"[:63].rstrip("-")


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ── CR → dict conversion ──────────────────────────────────────────────────────

def cr_to_dict(cr: dict, side: str) -> dict:
    """Convert a RemoteApp or ExecutingApp CR dict to the API response shape."""
    meta   = cr.get("metadata", {})
    labels = meta.get("labels", {})
    ann    = meta.get("annotations", {})
    status = cr.get("status", {})
    spec   = dict(cr.get("spec", {}))
    spec.pop("targetPeer", None)  # internal field, not shown in UI
    return {
        "id":          labels.get("porpulsion.io/app-id", ""),
        "name":        ann.get("porpulsion.io/app-name", meta.get("name", "")),
        "spec":        spec,
        "source_peer": labels.get("porpulsion.io/source-peer", ""),
        "target_peer": labels.get("porpulsion.io/target-peer", ""),
        "status":      status.get("phase", "Unknown"),
        "cr_name":     meta.get("name", ""),
        "side":        side,
        "created_at":  status.get("createdAt", meta.get("creationTimestamp", "")),
        "updated_at":  status.get("updatedAt", status.get("lastUpdated", "")),
    }


def get_cr_by_app_id(namespace: str, app_id: str) -> tuple[dict | None, str]:
    """
    Find a RemoteApp or ExecutingApp CR by app-id label.
    Returns (cr_dict, "submitted"|"executing") or (None, "").
    """
    for plural, side in [(PLURAL, "submitted"), (PLURAL_EA, "executing")]:
        try:
            result = _crd_api.list_namespaced_custom_object(
                GROUP, VERSION, namespace, plural,
                label_selector=f"porpulsion.io/app-id={app_id}",
            )
            items = result.get("items", [])
            if items:
                return items[0], side
        except Exception:
            pass
    return None, ""


# ── RemoteApp CR operations ───────────────────────────────────────────────────

def validate_remoteapp_spec(namespace: str, app_id: str, app_name: str, spec_dict: dict, target_peer: str) -> str | None:
    """
    Dry-run a RemoteApp CR creation to validate spec_dict against the CRD schema.
    Returns None if valid (or CRD unavailable), or an error string if rejected.
    """
    if not _check_crd_available(namespace):
        return None

    cr_name = _cr_name(app_id, app_name)
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


def create_remoteapp_cr(namespace: str, app_id: str, app_name: str, spec_dict: dict,
                        target_peer: str, source_peer: str = "") -> str | None:
    """
    Create a RemoteApp CR on the local cluster. Returns the CR name, or None if unavailable.
    spec_dict should be the RemoteAppSpec.to_dict() output.
    """
    if not _check_crd_available(namespace):
        return None

    cr_name = _cr_name(app_id, app_name)
    cr_spec = dict(spec_dict)
    cr_spec["targetPeer"] = target_peer
    now = _now_iso()

    body = {
        "apiVersion": f"{GROUP}/{VERSION}",
        "kind": "RemoteApp",
        "metadata": {
            "name": cr_name,
            "namespace": namespace,
            "labels": {
                "porpulsion.io/app-id":     app_id,
                "porpulsion.io/target-peer": target_peer,
                "porpulsion.io/source-peer": source_peer,
            },
            "annotations": {
                "porpulsion.io/app-name": app_name,
            },
        },
        "spec": cr_spec,
    }
    try:
        _crd_api.create_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, body)
        log.info("Created RemoteApp CR %s/%s", namespace, cr_name)
        # Set initial status with timestamps (status subresource requires a separate patch)
        _patch_status(namespace, PLURAL, cr_name, {
            "phase": "Pending",
            "appId": app_id,
            "createdAt": now,
            "updatedAt": now,
        })
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
        "message":     message,
        "lastUpdated": _now_iso(),
        "updatedAt":   _now_iso(),
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


# ── ExecutingApp CR operations ────────────────────────────────────────────────

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
            "annotations": {
                "porpulsion.io/app-name": app_name,
            },
        },
        "spec": spec_dict,
    }
    try:
        _crd_api.create_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL_EA, body)
        log.info("Created ExecutingApp CR %s/%s", namespace, cr_name)
        _patch_status(namespace, PLURAL_EA, cr_name, {
            "phase":     "Pending",
            "appId":     app_id,
            "createdAt": now,
            "updatedAt": now,
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


def update_executingapp_cr_status(namespace: str, cr_name: str, phase: str, app_id: str, message: str = "") -> None:
    """Patch the status subresource of an ExecutingApp CR."""
    if not _check_ea_crd_available(namespace):
        return
    _patch_status(namespace, PLURAL_EA, cr_name, {
        "phase":       phase,
        "appId":       app_id,
        "message":     message,
        "lastUpdated": _now_iso(),
        "updatedAt":   _now_iso(),
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
    """Find an ExecutingApp CR by app-id label. Returns the CR dict or None."""
    if not _check_ea_crd_available(namespace):
        return None
    try:
        result = _crd_api.list_namespaced_custom_object(
            GROUP, VERSION, namespace, PLURAL_EA,
            label_selector=f"porpulsion.io/app-id={app_id}",
        )
        items = result.get("items", [])
        return items[0] if items else None
    except Exception as e:
        log.warning("Failed to get ExecutingApp CR by app-id %s: %s", app_id, e)
        return None


# ── Internal helpers ──────────────────────────────────────────────────────────

def _patch_status(namespace: str, plural: str, cr_name: str, status_fields: dict) -> None:
    """Patch the status subresource of a CR (best-effort)."""
    body = {"status": status_fields}
    try:
        _crd_api.patch_namespaced_custom_object_status(GROUP, VERSION, namespace, plural, cr_name, body)
        log.debug("Patched %s/%s status → %s", plural, cr_name, status_fields.get("phase", "?"))
    except ApiException as e:
        log.warning("Failed to patch %s/%s status: %s", plural, cr_name, e)


# ── Schema helpers ────────────────────────────────────────────────────────────

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


# ── CR watcher ────────────────────────────────────────────────────────────────

def start_cr_watcher(namespace: str, on_modified) -> None:
    """
    Start a background thread that watches RemoteApp CRs for MODIFIED events.
    Calls on_modified(cr_obj) for each update.
    """
    if not _check_crd_available(namespace):
        log.info("CRD not available — CR watcher not started")
        return

    def _watch_loop():
        while True:
            try:
                w = watch.Watch()
                log.info("CRD watcher started for %s/%s in ns=%s", GROUP, PLURAL, namespace)
                for event in w.stream(
                    _crd_api.list_namespaced_custom_object,
                    GROUP, VERSION, namespace, PLURAL,
                    timeout_seconds=3600,
                ):
                    evt_type = event.get("type", "")
                    obj = event.get("object", {})
                    if evt_type == "MODIFIED":
                        try:
                            on_modified(obj)
                        except Exception as e:
                            log.warning("CR watcher on_modified error: %s", e)
            except ApiException as e:
                log.warning("CRD watch stream error: %s — retrying in 10s", e)
                time.sleep(10)
            except Exception as e:
                log.warning("CRD watcher unexpected error: %s — retrying in 10s", e)
                time.sleep(10)

    t = threading.Thread(target=_watch_loop, daemon=True, name="cr-watcher")
    t.start()
