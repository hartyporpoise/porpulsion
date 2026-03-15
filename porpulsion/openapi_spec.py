"""
OpenAPI 3 spec: auto-derived from @api_doc decorators on route functions.
Served at /api/openapi.json and /api/openapi.yaml.

To document a new route, add @api_doc(...) to the route function — no changes
needed here. The decorator stores metadata on the function; build_spec() walks
the Flask app's url_map to collect it automatically.
"""
import re
from apispec import APISpec

from porpulsion.openapi_schemas import (
    peer_entry_schema,
    schemas_from_models,
    status_schema,
)

# ── Shared schema refs ────────────────────────────────────────────────────────
REF_STATUS       = {"$ref": "#/components/schemas/Status"}
REF_PEER_ENTRY   = {"$ref": "#/components/schemas/PeerEntry"}
REF_REMOTE_APP   = {"$ref": "#/components/schemas/RemoteApp"}
REF_REMOTE_APP_SPEC = {"$ref": "#/components/schemas/RemoteAppSpec"}
REF_SETTINGS     = {"$ref": "#/components/schemas/Settings"}


# ── @api_doc decorator ────────────────────────────────────────────────────────

def api_doc(
    summary: str,
    *,
    description: str = "",
    tags: list[str] | None = None,
    operation_id: str = "",
    parameters: list[dict] | None = None,
    request_body: dict | None = None,
    responses: dict | None = None,
):
    """
    Attach OpenAPI metadata to a Flask route function.

    Example::

        @bp.route("/peers")
        @api_doc("List peers", tags=["Peers"],
                 responses={"200": {"description": "OK", ...}})
        def list_peers():
            ...
    """
    def decorator(fn):
        fn._api_doc = {
            "summary":      summary,
            "description":  description,
            "tags":         tags or [],
            "operationId":  operation_id or _to_operation_id(fn.__name__),
            "parameters":   parameters or [],
            "requestBody":  request_body,
            "responses":    responses or {"200": {"description": "OK"}},
        }
        return fn
    return decorator


def _to_operation_id(name: str) -> str:
    """Convert snake_case function name to camelCase operationId."""
    parts = name.split("_")
    return parts[0] + "".join(p.title() for p in parts[1:])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _flask_path_to_openapi(rule: str) -> str:
    """Convert Flask URL rule to OpenAPI path. e.g. /foo/<bar_id> → /foo/{bar_id}"""
    return re.sub(r"<(?:[^:>]+:)?([^>]+)>", r"{\1}", rule)


# ── Build spec from url_map ───────────────────────────────────────────────────

def build_spec(app) -> APISpec:
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

    spec.components.schema("PeerEntry", peer_entry_schema())
    spec.components.schema("Status", status_schema())
    for name, schema in schemas_from_models().items():
        spec.components.schema(name, schema)

    # Walk url_map: group methods by path, collect @api_doc metadata
    # Only include routes under /api/ prefix
    path_ops: dict[str, dict] = {}

    for rule in app.url_map.iter_rules():
        if not rule.rule.startswith("/api/"):
            continue
        openapi_path = _flask_path_to_openapi(rule.rule[len("/api"):])

        view_fn = app.view_functions.get(rule.endpoint)
        if view_fn is None:
            continue
        meta = getattr(view_fn, "_api_doc", None)
        if meta is None:
            continue

        op = {k: v for k, v in meta.items() if v}  # drop empty/None values
        # requestBody None is falsy but we want to keep non-None ones
        if meta.get("requestBody") is not None:
            op["requestBody"] = meta["requestBody"]
        if not op.get("responses"):
            op["responses"] = {"200": {"description": "OK"}}

        methods = {m.lower() for m in rule.methods or []} - {"head", "options"}
        for method in methods:
            path_ops.setdefault(openapi_path, {})[method] = op

    for path, operations in path_ops.items():
        spec.path(path=path, operations=operations)

    return spec


# ── Lazy singleton ────────────────────────────────────────────────────────────

_spec: APISpec | None = None


def get_openapi_dict(app=None) -> dict:
    global _spec
    if _spec is None:
        if app is None:
            from porpulsion.agent import app as _app
            app = _app
        _spec = build_spec(app)
    return _spec.to_dict()


def invalidate_spec():
    """Call this when routes are dynamically added (not needed in normal use)."""
    global _spec
    _spec = None


def get_openapi_yaml() -> str:
    import yaml
    return yaml.dump(get_openapi_dict(), default_flow_style=False, allow_unicode=True, sort_keys=False)
