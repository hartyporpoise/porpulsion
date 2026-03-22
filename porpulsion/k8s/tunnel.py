"""
HTTP proxy helper for porpulsion RemoteApp port forwarding.

Provides `proxy_request` — used by the executing agent to forward an
inbound HTTP request (received from the submitting agent over mTLS) to
the RemoteApp's Service (load-balanced across pods), then stream the response back.

Scope enforcement: Service is resolved from k8s at call time using the
porpulsion.io/remote-app-id label, so the caller never supplies a target address.
"""
import logging
import time
from porpulsion import state

log = logging.getLogger("porpulsion.tunnel")

NAMESPACE = state.NAMESPACE

_SVC_HOST_TTL = 30.0  # seconds
_svc_host_cache: dict[str, tuple[str, float]] = {}  # app_id -> (host, expiry)


def _k8s_core_v1():
    from kubernetes import client, config as kube_config
    try:
        kube_config.load_incluster_config()
    except Exception:
        kube_config.load_kube_config()
    return client.CoreV1Api()


def resolve_service_host(remote_app_id: str) -> str:
    """
    Look up the Service name for a RemoteApp (same namespace).
    Returns host suitable for in-cluster HTTP: '<name>.<namespace>.svc.cluster.local'
    Raises ValueError if no Service is found.
    Result is cached for 30 s to avoid a k8s round-trip on every proxied request.
    """
    now = time.monotonic()
    entry = _svc_host_cache.get(remote_app_id)
    if entry and entry[1] > now:
        return entry[0]

    core_v1 = _k8s_core_v1()
    services = core_v1.list_namespaced_service(
        namespace=NAMESPACE,
        label_selector=f"porpulsion.io/remote-app-id={remote_app_id}",
    )
    if not services.items:
        raise ValueError(f"no service for remote-app-id={remote_app_id}")
    name = services.items[0].metadata.name
    host = f"{name}.{NAMESPACE}.svc.cluster.local"
    _svc_host_cache[remote_app_id] = (host, now + _SVC_HOST_TTL)
    return host


def proxy_request(remote_app_id: str, port: int,
                  method: str, path: str,
                  headers: dict, body: bytes) -> tuple[int, dict, bytes]:
    """
    Forward an HTTP request to the RemoteApp's Service (load-balanced across pods).

    Returns (status_code, response_headers, response_body).
    """
    import requests as _req

    host = resolve_service_host(remote_app_id)
    url = f"http://{host}:{port}/{path.lstrip('/')}"

    # Strip hop-by-hop headers that must not be forwarded
    _skip = {"host", "transfer-encoding", "connection", "keep-alive",
              "proxy-authenticate", "proxy-authorization", "te", "trailers", "upgrade"}
    fwd_headers = {k: v for k, v in headers.items() if k.lower() not in _skip}

    try:
        resp = _req.request(
            method=method,
            url=url,
            headers=fwd_headers,
            data=body,
            timeout=30,
            allow_redirects=False,
            stream=False,
        )
        resp_headers = {k: v for k, v in resp.headers.items()
                        if k.lower() not in _skip}
        log.debug("Proxied %s %s -> %s: %d", method, path, url, resp.status_code)
        return resp.status_code, resp_headers, resp.content
    except Exception as exc:
        log.warning("Proxy error for app %s port %d: %s", remote_app_id, port, exc)
        raise
