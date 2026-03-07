"""
Porpulsion data models.

RemoteAppSpec is driven entirely by the installed CRD's openAPIV3Schema.
The CRD (charts/porpulsion/templates/crd.yaml) is the single source of truth
for spec fields, types, and defaults.  To add or remove a spec field, edit
crd.yaml and run `helm upgrade`  no Python changes required.

All other models (Peer, RemoteApp, AgentSettings, etc.) remain plain dataclasses.
"""
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal


# -- CRD-driven spec wrapper

class _DictWrapper:
    """
    Thin wrapper around a plain dict that exposes keys as attributes.
    Used for RemoteAppSpec and all nested spec objects (ports, env, volumes, etc.)
    so that existing code like `spec.image`, `cm.name`, `rp.httpGet` keeps working
    without any hardcoded field lists.

    Attribute writes (e.g. `spec.replicas = 2`) mutate the underlying dict.
    Missing keys return None rather than raising AttributeError.
    """
    __slots__ = ("_d",)

    def __init__(self, d: dict):
        object.__setattr__(self, "_d", d if isinstance(d, dict) else {})

    def __getattr__(self, name: str):
        try:
            return object.__getattribute__(self, "_d")[name]
        except KeyError:
            return None

    def __setattr__(self, name: str, value):
        object.__getattribute__(self, "_d")[name] = value

    def get(self, key, default=None):
        return object.__getattribute__(self, "_d").get(key, default)

    def to_dict(self) -> dict:
        return dict(object.__getattribute__(self, "_d"))

    def __repr__(self):
        return f"{self.__class__.__name__}({object.__getattribute__(self, '_d')!r})"


def _wrap(value, prop_schema: dict | None = None):
    """
    Wrap a raw JSON value according to its CRD schema type.
    - object  †’ _DictWrapper (with nested wrapping of its properties)
    - array of objects †’ list of _DictWrapper
    - array of scalars †’ plain list
    - scalar †’ value as-is
    When schema is None we infer from the value type.
    """
    if value is None:
        return None
    typ = (prop_schema or {}).get("type")
    if typ == "object" or (typ is None and isinstance(value, dict)):
        # Wrap sub-properties recursively
        sub_props = (prop_schema or {}).get("properties", {})
        wrapped = {}
        for k, v in value.items():
            wrapped[k] = _wrap(v, sub_props.get(k))
        return _DictWrapper(wrapped)
    if typ == "array" or (typ is None and isinstance(value, list)):
        item_schema = (prop_schema or {}).get("items", {})
        item_type = item_schema.get("type")
        if item_type == "object" or (item_type is None and value and isinstance(value[0], dict)):
            return [_wrap(i, item_schema) for i in value if isinstance(i, dict)]
        return list(value)
    return value


def _unwrap(value):
    """Recursively unwrap _DictWrapper objects back to plain dicts for serialization."""
    if isinstance(value, _DictWrapper):
        return {k: _unwrap(v) for k, v in object.__getattribute__(value, "_d").items()}
    if isinstance(value, list):
        return [_unwrap(i) for i in value]
    return value


class RemoteAppSpec(_DictWrapper):
    """
    A RemoteApp spec, loaded from the CRD's openAPIV3Schema at agent startup.

    Fields and their types come entirely from the installed CRD  no field list
    is hardcoded here.  Access any field as an attribute:

        spec.image          # str
        spec.replicas       # int
        spec.configMaps     # list of _DictWrapper with .name, .mountPath, .data
        spec.resources      # _DictWrapper with .requests, .limits dicts
        spec.env            # list of _DictWrapper with .name, .value, .valueFrom
        spec.readinessProbe # _DictWrapper or None
        spec.securityContext # _DictWrapper or None

    To add a new spec field: edit charts/porpulsion/templates/crd.yaml and
    run `helm upgrade`.  No Python changes needed.
    """

    @classmethod
    def from_dict(cls, d: dict) -> "RemoteAppSpec":
        """
        Parse a raw spec dict into a RemoteAppSpec.
        Uses the cached CRD schema to coerce types and apply defaults.
        Falls back to passthrough wrapping if the schema is unavailable.
        """
        if not isinstance(d, dict):
            d = {}
        from porpulsion.k8s.store import load_spec_schema
        schema_props = load_spec_schema() or {}

        coerced: dict = {}
        # Apply CRD defaults for known fields, then overlay what was provided
        for field_name, field_schema in schema_props.items():
            if field_name == "targetPeer":
                continue  # internal CRD field, not part of the user spec
            raw = d.get(field_name)
            if raw is None:
                default = field_schema.get("default")
                if default is not None:
                    coerced[field_name] = default
            else:
                coerced[field_name] = _coerce(raw, field_schema)

        # Also pass through any fields not in schema (forward-compat / CRD not loaded)
        for k, v in d.items():
            if k not in coerced and k != "targetPeer":
                coerced[k] = _wrap(v)

        # Ensure image always present
        if "image" not in coerced:
            coerced["image"] = d.get("image", "nginx:latest")
        if "replicas" not in coerced:
            coerced["replicas"] = max(1, int(d.get("replicas") or 1))

        obj = cls.__new__(cls)
        object.__setattr__(obj, "_d", coerced)
        return obj

    def to_dict(self) -> dict:
        """Serialize back to a plain dict, unwrapping all nested wrappers."""
        return _unwrap(self)

    def is_empty(self) -> bool:
        return not object.__getattribute__(self, "_d")


def _coerce(value, schema: dict):
    """Coerce a raw value to the type declared in the schema."""
    typ = schema.get("type")
    if value is None:
        return schema.get("default")
    if typ == "integer":
        try:
            return int(value)
        except (TypeError, ValueError):
            return value
    if typ == "boolean":
        if isinstance(value, bool):
            return value
        return str(value).lower() in ("true", "1", "yes")
    if typ == "string":
        return str(value)
    if typ == "array":
        if not isinstance(value, list):
            return []
        return _wrap(value, schema)
    if typ == "object":
        if not isinstance(value, dict):
            return _DictWrapper({})
        return _wrap(value, schema)
    return _wrap(value, schema)


# -- Remaining models (plain dataclasses)


@dataclass
class Peer:
    name: str
    url: str
    ca_pem: str = ""  # PEM CA cert received from this peer during handshake (internal only)
    connected_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    # CRD schema diff set on connect: {"missing_local": [...], "missing_remote": [...]}
    # missing_remote = fields this peer lacks; missing_local = fields we lack
    crd_diff: dict = field(default_factory=dict)

    def to_dict(self):
        d = {"name": self.name, "url": self.url, "connected_at": self.connected_at}
        if self.crd_diff:
            d["crd_diff"] = self.crd_diff
        return d


@dataclass
class RemoteApp:
    name: str
    spec: RemoteAppSpec
    source_peer: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    status: str = "Pending"
    target_peer: str = ""
    cr_name: str = ""
    resource_name: str = ""  # sanitized k8s name used for Deployment/CM/Secret/PVC
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "spec": self.spec.to_dict() if isinstance(self.spec, RemoteAppSpec) else self.spec,
            "source_peer": self.source_peer,
            "target_peer": self.target_peer,
            "status": self.status,
            "cr_name": self.cr_name,
            "resource_name": self.resource_name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class TunnelRequest:
    """A pending tunnel request from a peer, waiting for local approval."""
    id: str
    peer_name: str
    remote_app_id: str
    target_port: int
    status: Literal["pending", "approved", "rejected"] = "pending"
    requested_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self):
        return {
            "id": self.id,
            "peer_name": self.peer_name,
            "remote_app_id": self.remote_app_id,
            "target_port": self.target_port,
            "status": self.status,
            "requested_at": self.requested_at,
        }


@dataclass
class AgentSettings:
    """
    Persistent (in-memory) settings for this agent.

    Access control:
      allow_inbound_remoteapps    accept RemoteApp submissions from peers
      require_remoteapp_approval  queue inbound apps for manual approval before executing
      allowed_images              comma-separated image prefixes; empty = allow all
      blocked_images              comma-separated image prefixes always rejected
      allowed_source_peers        comma-separated peer names that may submit; empty = all connected
      allow_pvcs                  allow inbound RemoteApps to request PVCs (default: False)

    Resource quotas (enforced on inbound RemoteApp submissions).
    All cpu/memory values are k8s quantity strings, e.g. "500m", "1", "256Mi", "2Gi".
    Empty string = unlimited.

      Presence requirements (checked before numeric limits):
        require_resource_requests  reject apps that don't specify resources.requests.cpu/memory
        require_resource_limits    reject apps that don't specify resources.limits.cpu/memory

      Per-pod:
        max_cpu_request_per_pod     max cpu request per pod
        max_cpu_limit_per_pod       max cpu limit per pod
        max_memory_request_per_pod  max memory request per pod
        max_memory_limit_per_pod    max memory limit per pod
        max_replicas_per_app        max replicas for a single app (0 = unlimited)

      Aggregate:
        max_total_deployments       max concurrent RemoteApp deployments (0 = unlimited)
        max_total_pods              max total pods across all deployments (0 = unlimited)
        max_total_cpu_requests      max total cpu requests across all running apps
        max_total_memory_requests   max total memory requests across all running apps
    """
    # Access control
    allow_inbound_remoteapps: bool = True
    require_remoteapp_approval: bool = False
    allowed_images: str = ""            # comma-separated prefixes; empty = allow all
    blocked_images: str = ""            # comma-separated prefixes; always denied
    allowed_source_peers: str = ""      # comma-separated peer names; empty = all connected
    allow_pvcs: bool = False            # allow inbound apps to request PVCs

    # Tunnel control
    allow_inbound_tunnels: bool = True
    tunnel_approval_mode: Literal["manual", "auto", "per_peer"] = "auto"
    allowed_tunnel_peers: str = ""      # comma-separated peer names allowed to open tunnels; empty = all connected

    # Diagnostics
    log_level: str = "INFO"

    # Resource presence requirements
    require_resource_requests: bool = False
    require_resource_limits: bool = False

    # Per-pod resource quotas (k8s quantity strings; "" = unlimited)
    max_cpu_request_per_pod: str = ""
    max_cpu_limit_per_pod: str = ""
    max_memory_request_per_pod: str = ""
    max_memory_limit_per_pod: str = ""
    max_replicas_per_app: int = 0

    # Aggregate quotas
    max_total_deployments: int = 0
    max_total_pods: int = 0
    max_total_cpu_requests: str = ""
    max_total_memory_requests: str = ""

    # PVC storage quotas (in GB; 0 = unlimited)
    max_pvc_storage_per_pvc_gb: int = 0   # max storage per single PVC claim
    max_pvc_storage_total_gb: int = 0     # max total PVC storage across all apps

    def to_dict(self):
        return {
            "require_resource_requests": self.require_resource_requests,
            "require_resource_limits": self.require_resource_limits,
            "allow_inbound_remoteapps": self.allow_inbound_remoteapps,
            "require_remoteapp_approval": self.require_remoteapp_approval,
            "allowed_images": self.allowed_images,
            "blocked_images": self.blocked_images,
            "allowed_source_peers": self.allowed_source_peers,
            "allow_pvcs": self.allow_pvcs,
            "allow_inbound_tunnels": self.allow_inbound_tunnels,
            "tunnel_approval_mode": self.tunnel_approval_mode,
            "allowed_tunnel_peers": self.allowed_tunnel_peers,
            "log_level": self.log_level,
            "max_cpu_request_per_pod": self.max_cpu_request_per_pod,
            "max_cpu_limit_per_pod": self.max_cpu_limit_per_pod,
            "max_memory_request_per_pod": self.max_memory_request_per_pod,
            "max_memory_limit_per_pod": self.max_memory_limit_per_pod,
            "max_replicas_per_app": self.max_replicas_per_app,
            "max_total_deployments": self.max_total_deployments,
            "max_total_pods": self.max_total_pods,
            "max_total_cpu_requests": self.max_total_cpu_requests,
            "max_total_memory_requests": self.max_total_memory_requests,
            "max_pvc_storage_per_pvc_gb": self.max_pvc_storage_per_pvc_gb,
            "max_pvc_storage_total_gb": self.max_pvc_storage_total_gb,
        }
