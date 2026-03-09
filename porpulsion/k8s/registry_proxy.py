"""
OCI Distribution Spec v2 pull-through proxy.

Runs on the *executing* side, bound to 0.0.0.0:5100, and exposed via a
dedicated ClusterIP-only Service (porpulsion-registry).  Kubelet on the
worker node reaches it via the in-cluster DNS name:
    porpulsion-registry.<namespace>.svc.cluster.local:5100

Using a separate ClusterIP Service (not the main service) ensures this port
is never exposed outside the cluster regardless of how the main service is
configured (NodePort, LoadBalancer, etc.).

Pull flow:
  kubelet
    → GET porpulsion.<ns>.svc.cluster.local:5100/v2/<name>/manifests/<ref>
      → registry/manifest WS call to the submitting peer
        → peer fetches from real registry (using its stored credentials)
          → manifest JSON returned
    → GET localhost:5100/v2/<name>/blobs/<digest>
      → registry/blob WS call to the submitting peer
        → peer fetches blob and returns it base64-encoded in chunks

Blob chunking:
  Blobs can be large (100s of MB). They are returned in ≤512KB base64 chunks
  as a sequence of registry/blob-chunk push messages followed by a final
  registry/blob-end message (which also carries the full digest for verification).

One proxy instance serves all peers — the URL path carries both an auth token
and the peer name:
    /v2/<token>/<peer_name>/<image_name>/manifests/<ref>
    /v2/<token>/<peer_name>/<image_name>/blobs/<digest>

Token:
    HMAC-SHA256(key=sha256(peer_ca_pem), msg=peer_name)
    Computed by proxy_image_ref() on the executing side (which holds the CA).
    Verified by the proxy on every request before any registry call is made.
    Stateless — no extra storage required.

The executing side's image ref is rewritten from:
    registry.example.com/myapp:latest
to:
    porpulsion-registry.<ns>.svc.cluster.local:5100/<token>/<peer_name>/registry.example.com/myapp:latest
"""
import base64
import datetime
import hashlib
import hmac
import json
import logging
import queue
import ssl
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

log = logging.getLogger("porpulsion.registry_proxy")

_PROXY_PORT   = 5100
_BLOB_TIMEOUT = 120   # seconds to wait for blob transfer completion

# Transfer state: transfer_id -> Queue of (seq, b64_chunk, done, error)
_transfers: dict[str, queue.Queue] = {}
_transfers_lock = threading.Lock()


def _peer_token(peer_name: str, ca_pem: str) -> str:
    """
    Derive a per-peer auth token from the peer's CA PEM.

    token = HMAC-SHA256(key=SHA256(ca_pem_bytes), msg=peer_name_bytes)

    Only the executing side (which holds the peer CA) can compute this.
    An attacker who knows only the peer_name cannot forge the token without
    the CA, making the URL self-authenticating.
    """
    key = hashlib.sha256(ca_pem.encode() if isinstance(ca_pem, str) else ca_pem).digest()
    return hmac.new(key, peer_name.encode(), hashlib.sha256).hexdigest()


def _get_channel(peer_name: str):
    from porpulsion.channel import get_channel
    return get_channel(peer_name, wait=5.0)


class _OciHandler(BaseHTTPRequestHandler):
    """Minimal OCI Distribution Spec v2 pull handler."""

    def log_message(self, fmt, *args):
        log.debug("registry-proxy: " + fmt, *args)

    def _send_error(self, code: int, detail: str = ""):
        body = f'{{"errors":[{{"code":"PROXY_ERROR","message":{detail!r}}}]}}'.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]  # strip query string
        parts = path.lstrip("/").split("/")

        # /v2/ ping - required by OCI spec
        if path in ("/v2", "/v2/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
            return

        # Must start with /v2/
        # Expected: /v2/<token>/<peer_name>/<image...>/manifests|blobs/<ref>
        if not parts or parts[0] != "v2" or len(parts) < 5:
            self._send_error(400, "bad path")
            return

        # parts[1] = token
        # parts[2] = peer_name
        # parts[3..n-2] = image name (may contain slashes)
        # parts[n-2] = "manifests" or "blobs"
        # parts[n-1] = ref or digest
        token     = parts[1]
        peer_name = parts[2]
        endpoint  = parts[-2]   # "manifests" or "blobs"
        ref       = parts[-1]
        # image name = everything between peer_name and endpoint, rejoined
        image_parts = parts[3:-2]
        image_name  = "/".join(image_parts)

        # Reject requests for unknown peers
        from porpulsion import state
        peer = state.peers.get(peer_name)
        if peer is None:
            log.warning("registry-proxy: rejected request for unknown peer %r", peer_name)
            self._send_error(403, "forbidden")
            return

        # Verify the HMAC token — proves the caller holds the peer CA
        expected = _peer_token(peer_name, peer.ca_pem)
        if not hmac.compare_digest(token, expected):
            log.warning("registry-proxy: invalid token for peer %r", peer_name)
            self._send_error(403, "forbidden")
            return

        if endpoint == "manifests":
            self._handle_manifest(peer_name, image_name, ref)
        elif endpoint == "blobs":
            self._handle_blob(peer_name, image_name, ref)
        else:
            self._send_error(400, f"unsupported endpoint: {endpoint}")

    def do_HEAD(self):
        # HEAD requests for manifest existence checks
        self.do_GET()

    def _handle_manifest(self, peer_name: str, image_name: str, ref: str):
        try:
            ch = _get_channel(peer_name)
            result = ch.call("registry/manifest", {
                "image":           image_name,
                "ref":             ref,
                "registry_secret": get_peer_secret(peer_name),
            }, timeout=30)
        except Exception as exc:
            log.warning("registry-proxy: manifest call failed for %s/%s:%s: %s",
                        peer_name, image_name, ref, exc)
            self._send_error(503, str(exc))
            return

        if not result.get("ok", True) or "error" in result:
            self._send_error(404, result.get("error", "not found"))
            return

        body = base64.b64decode(result["manifest"])
        ct   = result.get("content_type", "application/vnd.docker.distribution.manifest.v2+json")
        digest = result.get("digest", "")

        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        if digest:
            self.send_header("Docker-Content-Digest", digest)
        self.end_headers()
        self.wfile.write(body)

    def _handle_blob(self, peer_name: str, image_name: str, digest: str):
        transfer_id = uuid.uuid4().hex
        q: queue.Queue = queue.Queue(maxsize=32)
        with _transfers_lock:
            _transfers[transfer_id] = q

        try:
            ch = _get_channel(peer_name)
            # Kick off the blob stream — this returns immediately with metadata
            meta = ch.call("registry/blob", {
                "image":           image_name,
                "digest":          digest,
                "transfer_id":     transfer_id,
                "registry_secret": get_peer_secret(peer_name),
            }, timeout=30)
        except Exception as exc:
            with _transfers_lock:
                _transfers.pop(transfer_id, None)
            log.warning("registry-proxy: blob call failed for %s@%s: %s",
                        image_name, digest, exc)
            self._send_error(503, str(exc))
            return

        if not meta.get("ok", True) or "error" in meta:
            with _transfers_lock:
                _transfers.pop(transfer_id, None)
            self._send_error(404, meta.get("error", "blob not found"))
            return

        total_size = meta.get("size", 0)
        content_type = meta.get("content_type", "application/octet-stream")

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if total_size:
            self.send_header("Content-Length", str(total_size))
        self.send_header("Docker-Content-Digest", digest)
        self.end_headers()

        # Stream chunks as they arrive from the WS channel
        try:
            while True:
                try:
                    chunk_info = q.get(timeout=_BLOB_TIMEOUT)
                except queue.Empty:
                    log.warning("registry-proxy: blob transfer %s timed out", transfer_id)
                    break

                if chunk_info.get("error"):
                    log.warning("registry-proxy: blob transfer error: %s", chunk_info["error"])
                    break

                data = base64.b64decode(chunk_info["data"])
                self.wfile.write(data)

                if chunk_info.get("done"):
                    break
        except Exception as exc:
            log.warning("registry-proxy: blob stream write error: %s", exc)
        finally:
            with _transfers_lock:
                _transfers.pop(transfer_id, None)


def deliver_blob_chunk(transfer_id: str, seq: int, data_b64: str,
                        done: bool, error: str = "") -> None:
    """
    Called by channel_handlers when a registry/blob-chunk push arrives.
    Puts the chunk into the waiting transfer queue.
    """
    with _transfers_lock:
        q = _transfers.get(transfer_id)
    if q is None:
        log.debug("registry-proxy: no waiting transfer for id %s (chunk %d)", transfer_id, seq)
        return
    q.put({"seq": seq, "data": data_b64, "done": done, "error": error})


# Mapping of peer_name -> registry_secret_name so the OCI proxy can include
# it in WS calls without needing it in the URL.
_peer_registry_secrets: dict[str, str] = {}
_peer_secrets_lock = threading.Lock()


def register_peer_secret(peer_name: str, secret_name: str) -> None:
    """Associate a docker-registry Secret name with a peer for proxy calls."""
    with _peer_secrets_lock:
        _peer_registry_secrets[peer_name] = secret_name


def get_peer_secret(peer_name: str) -> str:
    with _peer_secrets_lock:
        return _peer_registry_secrets.get(peer_name, "")


_server: HTTPServer | None = None
_server_lock = threading.Lock()

# PEM bytes of the proxy's self-signed CA — set once by start_proxy()
_proxy_ca_pem: bytes | None = None

_PULL_SECRET_NAME = "porpulsion-registry-ca"


def _generate_proxy_tls(namespace: str) -> tuple[bytes, bytes, bytes]:
    """
    Generate (or load cached) a self-signed CA + leaf TLS cert for the proxy.

    The CA cert is stored in the porpulsion-credentials Secret under the key
    'registry-proxy-ca.crt' so it survives pod restarts and can be retrieved
    for the imagePullSecret without regenerating.

    Returns (ca_cert_pem, leaf_cert_pem, leaf_key_pem) as bytes.
    """
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from porpulsion import tls as _tls

    core_v1 = _tls._k8s_core_v1()

    # Try to load existing proxy CA from the credentials secret
    try:
        secret = core_v1.read_namespaced_secret("porpulsion-credentials", namespace)
        d = secret.data or {}
        if "registry-proxy-ca.crt" in d and "registry-proxy.crt" in d and "registry-proxy.key" in d:
            log.debug("Loaded existing registry proxy TLS certs from Secret")
            return (
                base64.b64decode(d["registry-proxy-ca.crt"]),
                base64.b64decode(d["registry-proxy.crt"]),
                base64.b64decode(d["registry-proxy.key"]),
            )
    except Exception:
        pass

    log.info("Generating registry proxy TLS cert for namespace %s", namespace)
    svc_dns = f"porpulsion-registry.{namespace}.svc.cluster.local"
    now = datetime.datetime.now(datetime.timezone.utc)

    # Self-signed CA
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "porpulsion-registry-ca")])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name).issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    ca_cert_pem = ca_cert.public_bytes(serialization.Encoding.PEM)
    ca_key_pem_bytes = ca_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )

    # Leaf cert signed by the CA, valid for the ClusterIP service DNS name
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, svc_dns)]))
        .issuer_name(ca_name)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(svc_dns)]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    leaf_cert_pem = leaf_cert.public_bytes(serialization.Encoding.PEM)
    leaf_key_pem = leaf_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )

    # Persist to credentials secret so certs survive restarts
    try:
        _tls._patch_secret(core_v1, namespace, "porpulsion-credentials", {
            "registry-proxy-ca.crt": base64.b64encode(ca_cert_pem).decode(),
            "registry-proxy.crt":    base64.b64encode(leaf_cert_pem).decode(),
            "registry-proxy.key":    base64.b64encode(leaf_key_pem).decode(),
        })
    except Exception as exc:
        log.warning("Could not persist registry proxy TLS to Secret: %s", exc)

    return ca_cert_pem, leaf_cert_pem, leaf_key_pem


def ensure_pull_secret(namespace: str) -> str:
    """
    Create (or update) a kubernetes.io/dockerconfigjson Secret containing the
    registry proxy's CA cert so containerd trusts the proxy's TLS certificate.

    Returns the Secret name ('porpulsion-registry-ca').
    """
    global _proxy_ca_pem
    if _proxy_ca_pem is None:
        raise RuntimeError("registry proxy not started — cannot create pull secret")

    from porpulsion import tls as _tls
    from kubernetes import client as k8s_client

    svc_host = f"porpulsion-registry.{namespace}.svc.cluster.local:{_PROXY_PORT}"

    # dockerconfigjson format — no credentials needed, just the registry entry
    # so containerd knows to use our CA for TLS verification.
    docker_config = {
        "auths": {
            svc_host: {
                "auth": base64.b64encode(b"porpulsion:porpulsion").decode(),
            }
        }
    }
    ca_b64 = base64.b64encode(_proxy_ca_pem).decode()

    core_v1 = _tls._k8s_core_v1()
    secret = k8s_client.V1Secret(
        metadata=k8s_client.V1ObjectMeta(name=_PULL_SECRET_NAME, namespace=namespace),
        type="kubernetes.io/dockerconfigjson",
        data={
            ".dockerconfigjson": base64.b64encode(
                json.dumps(docker_config).encode()
            ).decode(),
            "ca.crt": ca_b64,
        },
    )
    try:
        core_v1.create_namespaced_secret(namespace, secret)
        log.info("Created imagePullSecret %s", _PULL_SECRET_NAME)
    except k8s_client.ApiException as e:
        if e.status == 409:
            core_v1.replace_namespaced_secret(_PULL_SECRET_NAME, namespace, secret)
            log.debug("Updated imagePullSecret %s", _PULL_SECRET_NAME)
        else:
            log.warning("Could not create imagePullSecret: %s", e)
    return _PULL_SECRET_NAME


def start_proxy() -> int:
    """
    Start the OCI pull-through proxy over HTTPS using a self-signed cert.

    The cert is signed by a per-agent CA stored in the porpulsion-credentials
    Secret. The CA is distributed to workload pods via an imagePullSecret
    (porpulsion-registry-ca) so containerd trusts the proxy's TLS certificate
    without any node-level configuration.

    Idempotent — safe to call multiple times.
    Returns the port the proxy is listening on.
    """
    global _server, _proxy_ca_pem
    with _server_lock:
        if _server is not None:
            return _server.server_address[1]

        from porpulsion import state
        ca_pem, leaf_cert_pem, leaf_key_pem = _generate_proxy_tls(state.NAMESPACE)
        _proxy_ca_pem = ca_pem

        # Write cert + key to temp files (ssl.SSLContext requires file paths)
        cert_file = tempfile.NamedTemporaryFile(delete=False, suffix=".crt")
        cert_file.write(leaf_cert_pem)
        cert_file.flush()

        key_file = tempfile.NamedTemporaryFile(delete=False, suffix=".key")
        key_file.write(leaf_key_pem)
        key_file.flush()

        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert_file.name, key_file.name)

        server = HTTPServer(("0.0.0.0", _PROXY_PORT), _OciHandler)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        _server = server

    t = threading.Thread(target=server.serve_forever, daemon=True,
                         name="registry-proxy")
    t.start()
    log.info("Registry pull-through proxy started on 0.0.0.0:%d (HTTPS)", _PROXY_PORT)
    return _PROXY_PORT


def stop_proxy() -> None:
    global _server
    with _server_lock:
        if _server:
            _server.shutdown()
            _server = None


def proxy_image_ref(peer_name: str, image: str) -> str:
    """
    Rewrite an image reference so kubelet pulls via the in-cluster OCI proxy.

    The URL embeds an HMAC token derived from the peer's CA PEM so that the
    proxy can verify the request is legitimate even if port 5100 is accidentally
    exposed — an attacker without the CA cannot forge the token.

    registry.example.com/myapp:latest
      → porpulsion-registry.<ns>.svc.cluster.local:5100/<token>/<peer_name>/registry.example.com/myapp:latest
    """
    from porpulsion import state
    port = start_proxy()
    peer = state.peers.get(peer_name)
    if peer is None:
        raise ValueError(f"proxy_image_ref: unknown peer {peer_name!r}")
    token = _peer_token(peer_name, peer.ca_pem)
    svc_host = f"porpulsion-registry.{state.NAMESPACE}.svc.cluster.local"
    return f"{svc_host}:{port}/{token}/{peer_name}/{image}"
