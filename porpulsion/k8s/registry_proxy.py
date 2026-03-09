"""
OCI registry pull-through proxy — TLS-intercepting MITM design.

Runs on the *executing* side, bound to 0.0.0.0:5100, exposed via a dedicated
ClusterIP-only Service (porpulsion-registry).  containerd on each worker node
reaches it via the Service ClusterIP (routable via kube-proxy on all k8s flavours).

How it works
────────────
containerd connects to <clusterIP>:5100 and trusts our proxy CA (delivered via
the porpulsion-registry-ca imagePullSecret injected into every workload pod spec).

The proxy:
  1. Terminates TLS using a dynamically-generated leaf cert for the target
     registry hostname, signed by our per-agent CA (extracted from SNI).
  2. Verifies the HMAC token in the URL path (proves the request came from a
     pod whose spec was written by our executor).
  3. Forwards the request over a direct HTTPS connection to the real registry.
  4. Streams the real registry's response back to containerd verbatim.

URL format (rewritten by proxy_image_ref on the executing side):
    /v2/<token>/<peer_name>/<registry_host>/<image_path>/manifests/<ref>
    /v2/<token>/<peer_name>/<registry_host>/<image_path>/blobs/<digest>

Token: HMAC-SHA256(key=SHA256(peer_ca_pem), msg=peer_name)
  — only the executing side (which holds peer CAs) can compute this.

Registry credentials (registrySecret) are fetched from the submitting peer via
the WS channel on first use and cached in memory.  Blob data flows directly over
TCP from the real registry to containerd — no base64, no chunking, no queuing.

Security note
─────────────
This proxy acts as a TLS-intercepting MITM between containerd and the real
registry.  The executing cluster operator can observe registry traffic during
image pulls.  The CA private key lives only in the porpulsion-credentials Secret.
"""
import base64
import datetime
import hashlib
import hmac
import ipaddress
import json
import logging
import socket
import ssl
import tempfile
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

log = logging.getLogger("porpulsion.registry_proxy")

_PROXY_PORT = 5100

# Per-registry leaf cert cache: registry_host -> (cert_pem, key_pem)
_leaf_cert_cache: dict[str, tuple[bytes, bytes]] = {}
_leaf_cert_lock = threading.Lock()

# Mapping of peer_name -> registry_secret_name
_peer_registry_secrets: dict[str, str] = {}
_peer_secrets_lock = threading.Lock()

_server: HTTPServer | None = None
_server_lock = threading.Lock()

# CA cert/key PEM bytes — set once by start_proxy()
_proxy_ca_pem: bytes | None = None
_proxy_ca_key_pem: bytes | None = None

# ClusterIP of the porpulsion-registry Service — set once by start_proxy()
_registry_cluster_ip: str | None = None

_PULL_SECRET_NAME = "porpulsion-registry-ca"


# ── Auth token ────────────────────────────────────────────────────────────────

def _peer_token(peer_name: str, ca_pem: str) -> str:
    """
    HMAC-SHA256(key=SHA256(peer_ca_pem), msg=peer_name).
    Only the executing side (which holds peer CAs) can compute this.
    """
    key = hashlib.sha256(ca_pem.encode() if isinstance(ca_pem, str) else ca_pem).digest()
    return hmac.new(key, peer_name.encode(), hashlib.sha256).hexdigest()


# ── Per-registry leaf cert generation ────────────────────────────────────────

def _leaf_cert_for(registry_host: str) -> tuple[bytes, bytes]:
    """
    Return (cert_pem, key_pem) for a leaf cert covering registry_host,
    signed by our proxy CA.  Cached in memory for the lifetime of the process.
    """
    with _leaf_cert_lock:
        if registry_host in _leaf_cert_cache:
            return _leaf_cert_cache[registry_host]

    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509 import load_pem_x509_certificate
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    ca_cert = load_pem_x509_certificate(_proxy_ca_pem)
    ca_key  = load_pem_private_key(_proxy_ca_key_pem, password=None)

    now = datetime.datetime.now(datetime.timezone.utc)
    leaf_key = ec.generate_private_key(ec.SECP256R1())

    try:
        san_entries = [x509.IPAddress(ipaddress.ip_address(registry_host))]
    except ValueError:
        san_entries = [x509.DNSName(registry_host)]

    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, registry_host)]))
        .issuer_name(ca_cert.subject)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=397))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    cert_pem = leaf_cert.public_bytes(serialization.Encoding.PEM)
    key_pem  = leaf_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )

    with _leaf_cert_lock:
        _leaf_cert_cache[registry_host] = (cert_pem, key_pem)

    log.debug("Generated leaf cert for registry host %r", registry_host)
    return cert_pem, key_pem


# ── Registry credentials ──────────────────────────────────────────────────────

def register_peer_secret(peer_name: str, secret_name: str) -> None:
    """Associate a docker-registry Secret name with a peer for proxy requests."""
    with _peer_secrets_lock:
        _peer_registry_secrets[peer_name] = secret_name


def get_peer_secret(peer_name: str) -> str:
    with _peer_secrets_lock:
        return _peer_registry_secrets.get(peer_name, "")


# Cache: (peer_name, secret_name, registry_host) -> (creds, expires_at)
_registry_creds_cache: dict[tuple[str, str, str], tuple[str, float]] = {}
_registry_creds_lock = threading.Lock()
_CREDS_TTL = 3600.0  # re-fetch credentials after 1 hour


def _get_registry_credentials(peer_name: str, secret_name: str,
                               registry_host: str = "") -> str:
    """
    Fetch docker-registry credentials from the submitting peer via WS channel.
    Returns "user:password" for Basic auth, or "" if none / unavailable.
    Cached for _CREDS_TTL seconds so rotated secrets are picked up eventually.
    """
    import time as _time
    if not secret_name:
        return ""
    cache_key = (peer_name, secret_name, registry_host)
    with _registry_creds_lock:
        entry = _registry_creds_cache.get(cache_key)
        if entry is not None and _time.monotonic() < entry[1]:
            return entry[0]

    try:
        from porpulsion.channel import get_channel
        ch = get_channel(peer_name, wait=5.0)
        result = ch.call("registry/credentials", {
            "secret_name":   secret_name,
            "registry_host": registry_host,
        }, timeout=10)
        creds = result.get("credentials", "")
    except Exception as exc:
        log.warning("Could not fetch registry credentials for %r/%r: %s",
                    peer_name, secret_name, exc)
        creds = ""

    with _registry_creds_lock:
        _registry_creds_cache[cache_key] = (creds, _time.monotonic() + _CREDS_TTL)
    return creds


# ── HTTP handler ──────────────────────────────────────────────────────────────

class _MitmHandler(BaseHTTPRequestHandler):
    """
    TLS-intercepting OCI registry proxy handler.

    Accepts HTTPS from containerd, verifies HMAC token, then forwards to the
    real registry over a direct HTTPS connection and streams the response back.
    """

    def log_message(self, fmt, *args):
        log.debug("registry-proxy: " + fmt, *args)

    def _send_error(self, code: int, detail: str = ""):
        body = json.dumps({"errors": [{"code": "PROXY_ERROR", "message": detail}]}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _parse_path(self):
        """
        Parse /v2/<token>/<peer_name>/<registry_host>/<image...>/manifests|blobs/<ref>
        Returns (token, peer_name, registry_host, oci_path) or signals ping/error.
        """
        path = self.path.split("?")[0]
        parts = path.lstrip("/").split("/")

        if path in ("/v2", "/v2/"):
            return "ping", None, None, None

        # minimum: v2, token, peer_name, registry_host, image, endpoint, ref = 7
        if len(parts) < 7 or parts[0] != "v2":
            return None, None, None, None

        token         = parts[1]
        peer_name     = parts[2]
        registry_host = parts[3]
        oci_path      = "/v2/" + "/".join(parts[4:])
        return token, peer_name, registry_host, oci_path

    def _handle_request(self, method: str):
        token, peer_name, registry_host, oci_path = self._parse_path()

        if token == "ping":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
            return

        if token is None:
            self._send_error(400, "bad path")
            return

        from porpulsion import state
        peer = state.peers.get(peer_name)
        if peer is None:
            log.warning("registry-proxy: unknown peer %r", peer_name)
            self._send_error(403, "forbidden")
            return
        expected = _peer_token(peer_name, peer.ca_pem)
        if not hmac.compare_digest(token, expected):
            log.warning("registry-proxy: invalid token for peer %r", peer_name)
            self._send_error(403, "forbidden")
            return

        secret_name = get_peer_secret(peer_name)
        creds = _get_registry_credentials(peer_name, secret_name, registry_host)

        target_url = f"https://{registry_host}{oci_path}"
        if "?" in self.path:
            target_url += "?" + self.path.split("?", 1)[1]

        headers = {}
        if creds:
            headers["Authorization"] = "Basic " + base64.b64encode(creds.encode()).decode()
        for h in ("Accept", "Accept-Encoding", "User-Agent", "Range"):
            v = self.headers.get(h)
            if v:
                headers[h] = v

        body_data = None
        if method in ("POST", "PUT", "PATCH"):
            length = int(self.headers.get("Content-Length", 0))
            body_data = self.rfile.read(length) if length else None

        try:
            req = urllib.request.Request(target_url, data=body_data,
                                         headers=headers, method=method)
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in ("content-type", "content-length",
                                     "docker-content-digest",
                                     "docker-distribution-api-version",
                                     "www-authenticate", "location",
                                     "content-range", "etag"):
                        self.send_header(k, v)
                self.end_headers()
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        except urllib.error.HTTPError as exc:
            log.warning("registry-proxy: upstream %s %s -> %d", method, target_url, exc.code)
            self.send_response(exc.code)
            for k, v in exc.headers.items():
                if k.lower() in ("content-type", "www-authenticate",
                                 "docker-content-digest"):
                    self.send_header(k, v)
            body = exc.read()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        except Exception as exc:
            log.warning("registry-proxy: request failed %s %s: %s", method, target_url, exc)
            self._send_error(503, str(exc))

    def do_GET(self):
        self._handle_request("GET")

    def do_HEAD(self):
        self._handle_request("HEAD")

    def do_POST(self):
        self._handle_request("POST")


# ── SNI-aware SSL server ──────────────────────────────────────────────────────

class _SniSSLServer(HTTPServer):
    """
    HTTPServer that wraps each accepted socket with a per-connection SSLContext
    serving a leaf cert matching the SNI hostname from the ClientHello.
    Falls back to the ClusterIP if no SNI is present.
    """

    def __init__(self, *args, ca_pem: bytes, ca_key_pem: bytes,
                 cluster_ip: str | None, **kwargs):
        super().__init__(*args, **kwargs)
        self._ca_pem     = ca_pem
        self._ca_key_pem = ca_key_pem
        self._cluster_ip = cluster_ip

    def get_request(self):
        raw_sock, addr = self.socket.accept()
        sni_host = _peek_sni(raw_sock) or self._cluster_ip or "porpulsion-registry"
        cert_pem, key_pem = _leaf_cert_for(sni_host)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        import os as _os
        with tempfile.NamedTemporaryFile(delete=False, suffix=".crt") as cf:
            cf.write(cert_pem)
            cert_path = cf.name
        with tempfile.NamedTemporaryFile(delete=False, suffix=".key") as kf:
            kf.write(key_pem)
            key_path = kf.name
        try:
            ctx.load_cert_chain(cert_path, key_path)
        finally:
            _os.unlink(cert_path)
            _os.unlink(key_path)
        try:
            ssl_sock = ctx.wrap_socket(raw_sock, server_side=True)
        except ssl.SSLError as exc:
            log.debug("registry-proxy: TLS handshake failed from %s: %s", addr, exc)
            raw_sock.close()
            raise
        return ssl_sock, addr


def _peek_sni(sock: socket.socket) -> str | None:
    """
    Peek at the TLS ClientHello (without consuming bytes) and extract the SNI
    server_name extension.  Returns None if not found or on any error.
    """
    try:
        data = sock.recv(4096, socket.MSG_PEEK)
        if not data or data[0] != 0x16:
            return None
        if len(data) < 5:
            return None
        rec_len = int.from_bytes(data[3:5], "big")
        payload = data[5:5 + rec_len]
        if not payload or payload[0] != 0x01:
            return None
        hello = payload[4:]
        pos = 34  # skip client_version(2) + random(32)
        if pos >= len(hello):
            return None
        sid_len = hello[pos]; pos += 1 + sid_len
        if pos + 2 > len(hello):
            return None
        cs_len = int.from_bytes(hello[pos:pos+2], "big"); pos += 2 + cs_len
        if pos + 1 > len(hello):
            return None
        cm_len = hello[pos]; pos += 1 + cm_len
        if pos + 2 > len(hello):
            return None
        ext_len = int.from_bytes(hello[pos:pos+2], "big"); pos += 2
        end = pos + ext_len
        while pos + 4 <= end:
            ext_type     = int.from_bytes(hello[pos:pos+2], "big")
            ext_data_len = int.from_bytes(hello[pos+2:pos+4], "big")
            ext_data     = hello[pos+4:pos+4+ext_data_len]
            pos += 4 + ext_data_len
            if ext_type == 0x0000 and len(ext_data) > 5:  # SNI
                name_len = int.from_bytes(ext_data[3:5], "big")
                return ext_data[5:5+name_len].decode("ascii", errors="ignore")
    except Exception:
        pass
    return None


# ── Proxy CA generation ───────────────────────────────────────────────────────

def _lookup_registry_cluster_ip(namespace: str) -> str | None:
    """Return the ClusterIP of the porpulsion-registry Service, or None on error."""
    try:
        from porpulsion import tls as _tls
        core_v1 = _tls._k8s_core_v1()
        svc = core_v1.read_namespaced_service("porpulsion-registry", namespace)
        return svc.spec.cluster_ip or None
    except Exception as exc:
        log.warning("Could not look up registry ClusterIP: %s", exc)
        return None


def _generate_proxy_ca(namespace: str) -> tuple[bytes, bytes]:
    """
    Load or generate the proxy's self-signed CA cert + key.
    Persisted under registry-proxy-ca.crt / registry-proxy-ca.key in
    the porpulsion-credentials Secret.
    Returns (ca_cert_pem, ca_key_pem).
    """
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from porpulsion import tls as _tls

    core_v1 = _tls._k8s_core_v1()

    try:
        secret = core_v1.read_namespaced_secret("porpulsion-credentials", namespace)
        d = secret.data or {}
        if "registry-proxy-ca.crt" in d and "registry-proxy-ca.key" in d:
            log.debug("Loaded existing registry proxy CA from Secret")
            return (
                base64.b64decode(d["registry-proxy-ca.crt"]),
                base64.b64decode(d["registry-proxy-ca.key"]),
            )
    except Exception:
        pass

    log.info("Generating registry proxy CA for namespace %s", namespace)
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "porpulsion-registry-ca")])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name).issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, key_cert_sign=True, crl_sign=True,
            content_commitment=False, key_encipherment=False,
            data_encipherment=False, key_agreement=False,
            encipher_only=False, decipher_only=False,
        ), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    ca_cert_pem = ca_cert.public_bytes(serialization.Encoding.PEM)
    ca_key_pem = ca_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    try:
        _tls._patch_secret(core_v1, namespace, "porpulsion-credentials", {
            "registry-proxy-ca.crt": base64.b64encode(ca_cert_pem).decode(),
            "registry-proxy-ca.key": base64.b64encode(ca_key_pem).decode(),
        })
    except Exception as exc:
        log.warning("Could not persist registry proxy CA: %s", exc)

    return ca_cert_pem, ca_key_pem


# ── imagePullSecret ───────────────────────────────────────────────────────────

def ensure_pull_secret(namespace: str) -> str:
    """
    Create/update the porpulsion-registry-ca imagePullSecret carrying our CA cert
    so containerd trusts our MITM proxy's dynamically-generated leaf certs.
    Returns the Secret name.
    """
    if _proxy_ca_pem is None:
        raise RuntimeError("registry proxy not started — cannot create pull secret")

    from porpulsion import tls as _tls
    from kubernetes import client as k8s_client

    host = _registry_cluster_ip or f"porpulsion-registry.{namespace}.svc.cluster.local"
    svc_host = f"{host}:{_PROXY_PORT}"

    docker_config = {
        "auths": {
            svc_host: {
                "auth": base64.b64encode(b"porpulsion:porpulsion").decode(),
            }
        }
    }

    core_v1 = _tls._k8s_core_v1()
    secret = k8s_client.V1Secret(
        metadata=k8s_client.V1ObjectMeta(name=_PULL_SECRET_NAME, namespace=namespace),
        type="kubernetes.io/dockerconfigjson",
        data={
            ".dockerconfigjson": base64.b64encode(
                json.dumps(docker_config).encode()
            ).decode(),
            "ca.crt": base64.b64encode(_proxy_ca_pem).decode(),
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


# ── Start / stop ──────────────────────────────────────────────────────────────

def start_proxy() -> int:
    """
    Start the TLS-intercepting MITM registry proxy.

    Each connection gets a dynamically-generated leaf cert for the target
    registry hostname (from SNI), signed by our proxy CA.  containerd trusts
    our CA via the porpulsion-registry-ca imagePullSecret.

    Idempotent — safe to call multiple times.
    Returns the port the proxy is listening on.
    """
    global _server, _proxy_ca_pem, _proxy_ca_key_pem, _registry_cluster_ip
    with _server_lock:
        if _server is not None:
            return _server.server_address[1]

        from porpulsion import state
        cluster_ip = _lookup_registry_cluster_ip(state.NAMESPACE)
        _registry_cluster_ip = cluster_ip

        ca_pem, ca_key_pem = _generate_proxy_ca(state.NAMESPACE)
        _proxy_ca_pem     = ca_pem
        _proxy_ca_key_pem = ca_key_pem

        server = _SniSSLServer(
            ("0.0.0.0", _PROXY_PORT), _MitmHandler,
            ca_pem=ca_pem, ca_key_pem=ca_key_pem, cluster_ip=cluster_ip,
        )
        _server = server

    t = threading.Thread(target=server.serve_forever, daemon=True,
                         name="registry-proxy")
    t.start()
    log.info("Registry MITM proxy started on 0.0.0.0:%d (ClusterIP=%s)",
             _PROXY_PORT, _registry_cluster_ip or "unknown")
    return _PROXY_PORT


def stop_proxy() -> None:
    global _server
    with _server_lock:
        if _server:
            _server.shutdown()
            _server = None


def proxy_image_ref(peer_name: str, image: str) -> str:
    """
    Rewrite an image ref so containerd pulls via our MITM proxy.

    registry.example.com/myapp:latest
      → <clusterIP>:5100/<token>/<peer_name>/registry.example.com/myapp:latest

    The registry hostname is preserved as the first path segment after the
    peer info so the proxy can generate the correct SNI leaf cert and forward
    to the right upstream.
    """
    from porpulsion import state
    port = start_proxy()
    peer = state.peers.get(peer_name)
    if peer is None:
        raise ValueError(f"proxy_image_ref: unknown peer {peer_name!r}")
    token = _peer_token(peer_name, peer.ca_pem)
    host = _registry_cluster_ip or f"porpulsion-registry.{state.NAMESPACE}.svc.cluster.local"
    return f"{host}:{port}/{token}/{peer_name}/{image}"
