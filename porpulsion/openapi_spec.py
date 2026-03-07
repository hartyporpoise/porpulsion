"""
OpenAPI 3 spec: paths defined here, schemas marshalled from porpulsion.models.
Served at /openapi.json and /openapi.yaml.
"""
from apispec import APISpec

from porpulsion.openapi_schemas import (
    peer_entry_schema,
    remote_app_request_examples,
    schemas_from_models,
    status_schema,
)

# Refs used in paths
REF_STATUS = {"$ref": "#/components/schemas/Status"}
REF_PEER_ENTRY = {"$ref": "#/components/schemas/PeerEntry"}
REF_REMOTE_APP = {"$ref": "#/components/schemas/RemoteApp"}
REF_REMOTE_APP_SPEC = {"$ref": "#/components/schemas/RemoteAppSpec"}
REF_SETTINGS = {"$ref": "#/components/schemas/Settings"}


def build_spec() -> APISpec:
    spec = APISpec(
        title="Porpulsion Agent API",
        version="1.0.0",
        openapi_version="3.0.3",
        info=dict(
            description=(
                "Local management API for the Porpulsion agent (port 8000, internal only). "
                "Use the dashboard at `/` or `/ui`, or call these endpoints to manage peers, "
                "RemoteApps, tunnels, and settings."
            ),
        ),
    )
    spec.options["servers"] = [{"url": "/api", "description": "API base"}]

    # -- Components: schemas from models (marshalling only, no duplication)
    spec.components.schema("PeerEntry", peer_entry_schema())
    spec.components.schema("Status", status_schema())
    for name, schema in schemas_from_models().items():
        spec.components.schema(name, schema)

    # -- Paths
    def resp_json(schema, status="200", description="OK"):
        return {
            status: {
                "description": description,
                "content": {"application/json": {"schema": schema}},
            }
        }

    spec.path(
        path="/status",
        operations=dict(
            get=dict(
                summary="Agent health",
                description="Returns agent name, peer list summary, and app counts.",
                operationId="getStatus",
                responses=resp_json(REF_STATUS),
            )
        ),
    )
    spec.path(
        path="/peers",
        operations=dict(
            get=dict(
                summary="List peers",
                description="List all connected and pending peers with channel status.",
                operationId="listPeers",
                responses=resp_json(
                    {"type": "array", "items": REF_PEER_ENTRY},
                ),
            )
        ),
    )
    spec.path(
        path="/invite",
        operations=dict(
            get=dict(
                summary="Get signed invite bundle",
                description=(
                    "Returns a signed invite bundle for this agent. The bundle is a compact base64url blob "
                    "containing the agent name, URL, CA cert, and an ECDSA signature. The connecting peer "
                    "verifies the signature locally before making any network call — no separate fingerprint needed."
                ),
                operationId="getInvite",
                responses={
                    "200": {
                        "description": "OK",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "agent": {"type": "string"},
                                        "self_url": {"type": "string"},
                                        "bundle": {"type": "string", "description": "Signed base64url invite bundle"},
                                        "cert_fingerprint": {"type": "string", "description": "Human-readable only"},
                                    },
                                }
                            }
                        },
                    }
                },
            )
        ),
    )
    spec.path(
        path="/peers/connect",
        operations=dict(
            post=dict(
                summary="Connect to peer using invite bundle",
                description=(
                    "Initiate peering with another agent using their signed invite bundle. "
                    "The bundle signature is verified locally before any network call is made. "
                    "Authentication completes via the peer/hello challenge/response over the WS channel."
                ),
                operationId="connectPeer",
                requestBody={
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["bundle"],
                                "properties": {
                                    "bundle": {"type": "string", "description": "Signed base64url invite bundle from /invite"},
                                },
                            }
                        }
                    },
                },
                responses={
                    "200": {"description": "OK — WS channel connecting"},
                    "400": {"description": "Missing or invalid bundle"},
                    "409": {"description": "Already peered with this agent"},
                },
            )
        ),
    )
    spec.path(
        path="/peers/{peer_name}",
        operations=dict(
            delete=dict(
                summary="Remove peer",
                description="Remove a peer and disconnect. Submitted apps targeting this peer are marked Failed.",
                operationId="removePeer",
                parameters=[{"name": "peer_name", "in": "path", "required": True, "schema": {"type": "string"}}],
                responses={
                    "200": {
                        "description": "OK",
                        "content": {
                            "application/json": {
                                "schema": {"type": "object", "properties": {"ok": {"type": "boolean"}, "removed": {"type": "string"}}}
                            }
                        },
                    },
                    "404": {"description": "Peer not found"},
                },
            )
        ),
    )
    spec.path(
        path="/remoteapp",
        operations=dict(
            post=dict(
                summary="Deploy RemoteApp to peer",
                description="Submit a RemoteApp to the first available peer. Requires at least one connected peer. **Spec** follows the RemoteApp Spec (see schema); use the examples to try minimal, with resources, custom entrypoint, or readiness+security.",
                operationId="createRemoteApp",
                requestBody={
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["name"],
                                "properties": {"name": {"type": "string"}, "spec": REF_REMOTE_APP_SPEC},
                            },
                            "examples": remote_app_request_examples(),
                        }
                    },
                },
                responses={
                    "201": {"description": "Created", "content": {"application/json": {"schema": REF_REMOTE_APP}}},
                    "400": {"description": "name required"},
                    "502": {"description": "Failed to reach peer"},
                    "503": {"description": "No peers connected"},
                },
            )
        ),
    )
    spec.path(
        path="/remoteapp/pending-approval",
        operations=dict(
            get=dict(
                summary="List pending approval",
                description="RemoteApps awaiting approval on this cluster (when require_remoteapp_approval is on).",
                operationId="listPendingApproval",
                responses={"200": {"description": "OK", "content": {"application/json": {"schema": {"type": "array", "items": {}}}}}},
            )
        ),
    )
    spec.path(
        path="/remoteapp/{app_id}/approve",
        operations=dict(
            post=dict(
                summary="Approve RemoteApp",
                description="Approve a pending RemoteApp and start the workload.",
                operationId="approveRemoteApp",
                parameters=[{"name": "app_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                responses={"200": {"description": "OK"}, "404": {"description": "Not found"}},
            )
        ),
    )
    spec.path(
        path="/remoteapp/{app_id}/reject",
        operations=dict(
            post=dict(
                summary="Reject RemoteApp",
                description="Reject a pending RemoteApp. Source peer is notified.",
                operationId="rejectRemoteApp",
                parameters=[{"name": "app_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                responses={"200": {"description": "OK"}, "404": {"description": "Not found"}},
            )
        ),
    )
    spec.path(
        path="/remoteapps",
        operations=dict(
            get=dict(
                summary="List RemoteApps",
                description="All submitted (local) and executing (remote) apps.",
                operationId="listRemoteApps",
                responses={
                    "200": {
                        "description": "OK",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "submitted": {"type": "array", "items": REF_REMOTE_APP},
                                        "executing": {"type": "array", "items": REF_REMOTE_APP},
                                    },
                                }
                            }
                        },
                    }
                },
            )
        ),
    )
    spec.path(
        path="/remoteapp/{app_id}",
        operations=dict(
            delete=dict(
                summary="Delete RemoteApp",
                description="Delete a RemoteApp (submitted or executing). Notifies peer if applicable.",
                operationId="deleteRemoteApp",
                parameters=[{"name": "app_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                responses={"200": {"description": "OK"}, "404": {"description": "App not found"}},
            )
        ),
    )
    spec.path(
        path="/remoteapp/{app_id}/scale",
        operations=dict(
            post=dict(
                summary="Scale RemoteApp",
                description="Set replica count for a RemoteApp.",
                operationId="scaleRemoteApp",
                parameters=[{"name": "app_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                requestBody={
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["replicas"],
                                "properties": {"replicas": {"type": "integer", "minimum": 0}},
                            }
                        }
                    },
                },
                responses={
                    "200": {"description": "OK"},
                    "400": {"description": "replicas required or invalid"},
                    "404": {"description": "App not found"},
                    "502": {"description": "Peer not connected"},
                },
            )
        ),
    )
    spec.path(
        path="/remoteapp/{app_id}/detail",
        operations=dict(
            get=dict(
                summary="RemoteApp detail",
                description="App metadata plus K8s deployment status (or peer detail).",
                operationId="remoteAppDetail",
                parameters=[{"name": "app_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                responses={
                    "200": {
                        "description": "OK",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {"app": REF_REMOTE_APP, "k8s": {}},
                                }
                            }
                        },
                    },
                    "404": {"description": "App not found"},
                },
            )
        ),
    )
    spec.path(
        path="/remoteapp/{app_id}/spec",
        operations=dict(
            put=dict(
                summary="Update RemoteApp spec",
                description="Update the spec of a submitted (local) RemoteApp; forwarded to peer.",
                operationId="updateRemoteAppSpec",
                parameters=[{"name": "app_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                requestBody={
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["spec"],
                                "properties": {"spec": REF_REMOTE_APP_SPEC},
                            }
                        }
                    },
                },
                responses={
                    "200": {"description": "OK"},
                    "400": {"description": "spec required"},
                    "404": {"description": "App not found"},
                    "503": {"description": "Peer not connected"},
                },
            )
        ),
    )
    spec.path(
        path="/remoteapp/{app_id}/proxy/{port}",
        operations=dict(
            get=dict(summary="Proxy to RemoteApp (GET)", description="Proxy HTTP request to the app pod on the peer."),
            put=dict(summary="Proxy to RemoteApp (PUT)"),
            post=dict(summary="Proxy to RemoteApp (POST)"),
            delete=dict(summary="Proxy to RemoteApp (DELETE)"),
            patch=dict(summary="Proxy to RemoteApp (PATCH)"),
            head=dict(summary="Proxy to RemoteApp (HEAD)"),
            options=dict(summary="Proxy to RemoteApp (OPTIONS)"),
        ),
    )
    spec.path(
        path="/remoteapp/{app_id}/proxy/{port}/{path}",
        operations=dict(
            get=dict(summary="Proxy to RemoteApp path (GET)"),
            put=dict(summary="Proxy to RemoteApp path (PUT)"),
            post=dict(summary="Proxy to RemoteApp path (POST)"),
            delete=dict(summary="Proxy to RemoteApp path (DELETE)"),
            patch=dict(summary="Proxy to RemoteApp path (PATCH)"),
            head=dict(summary="Proxy to RemoteApp path (HEAD)"),
            options=dict(summary="Proxy to RemoteApp path (OPTIONS)"),
        ),
    )
    spec.path(
        path="/settings",
        operations=dict(
            get=dict(
                summary="Get settings",
                description="Current agent settings (approval mode, limits, image policy, etc.).",
                operationId="getSettings",
                responses=resp_json(REF_SETTINGS),
            ),
            post=dict(
                summary="Update settings",
                description="Update one or more settings. Persisted to ConfigMap.",
                operationId="updateSettings",
                requestBody={"content": {"application/json": {"schema": REF_SETTINGS}}},
                responses={
                    "200": {"description": "OK", "content": {"application/json": {"schema": REF_SETTINGS}}},
                    "400": {"description": "Validation error"},
                },
            ),
        ),
    )
    spec.path(
        path="/logs",
        operations=dict(
            get=dict(
                summary="Agent logs",
                description="Recent in-process log lines buffered by the agent. `tail` (default 200, max 500). `format=text` returns plain text.",
                operationId="getLogs",
                parameters=[
                    {"name": "tail", "in": "query", "schema": {"type": "integer", "default": 200}},
                    {"name": "format", "in": "query", "schema": {"type": "string", "enum": ["json", "text"], "default": "json"}},
                ],
                responses=resp_json({
                    "type": "object",
                    "properties": {
                        "lines": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "ts": {"type": "string"},
                                    "level": {"type": "string"},
                                    "message": {"type": "string"},
                                },
                            },
                        }
                    },
                }),
            )
        ),
    )
    spec.path(
        path="/remoteapp/{app_id}/logs",
        operations=dict(
            get=dict(
                summary="RemoteApp pod logs",
                description="Recent pod log lines for a RemoteApp executing on this cluster (or proxied from peer). `tail` default 200. `order=time` to sort by timestamp; `order=pod` to group by pod.",
                operationId="getAppLogs",
                parameters=[
                    {"name": "app_id", "in": "path", "required": True, "schema": {"type": "string"}},
                    {"name": "tail", "in": "query", "schema": {"type": "integer", "default": 200}},
                    {"name": "order", "in": "query", "schema": {"type": "string", "enum": ["pod", "time"], "default": "pod"}},
                ],
                responses={
                    "200": {
                        "description": "OK",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "lines": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "pod": {"type": "string"},
                                                    "message": {"type": "string"},
                                                    "ts": {"type": "string", "nullable": True},
                                                },
                                            },
                                        }
                                    },
                                }
                            }
                        },
                    },
                    "404": {"description": "App not found"},
                },
            )
        ),
    )
    spec.path(
        path="/notifications",
        operations=dict(
            get=dict(
                summary="List notifications",
                description="In-app notifications (newest first, capped at 50).",
                operationId="listNotifications",
                responses=resp_json({
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "level": {"type": "string", "enum": ["info", "warn", "error"]},
                            "title": {"type": "string"},
                            "message": {"type": "string"},
                            "ts": {"type": "string"},
                            "ack": {"type": "boolean"},
                        },
                    },
                }),
            ),
            delete=dict(
                summary="Clear all notifications",
                operationId="clearNotifications",
                responses={"200": {"description": "OK"}},
            ),
        ),
    )
    spec.path(
        path="/notifications/{notif_id}/ack",
        operations=dict(
            post=dict(
                summary="Acknowledge notification",
                operationId="ackNotification",
                parameters=[{"name": "notif_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                responses={"200": {"description": "OK"}, "404": {"description": "Not found"}},
            )
        ),
    )
    spec.path(
        path="/notifications/{notif_id}",
        operations=dict(
            delete=dict(
                summary="Delete notification",
                operationId="deleteNotification",
                parameters=[{"name": "notif_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                responses={"200": {"description": "OK"}},
            )
        ),
    )
    return spec


# Lazy singleton so we build once
_spec: APISpec | None = None


def get_openapi_dict() -> dict:
    """Return the OpenAPI spec as a dict (for JSON response)."""
    global _spec
    if _spec is None:
        _spec = build_spec()
    return _spec.to_dict()


def get_openapi_yaml() -> str:
    """Return the OpenAPI spec as YAML (for /openapi.yaml)."""
    import yaml
    return yaml.dump(
        get_openapi_dict(),
        default_flow_style=False,
        allow_unicode=True,
        sort_keys=False,
    )
