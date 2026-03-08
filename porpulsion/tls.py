"""
TLS certificate generation and management for porpulsion agents.

Each agent auto-generates a private CA (ECDSA P-256) on first boot, persisted
to the porpulsion-credentials Kubernetes Secret. The CA cert (never the key)
is exchanged during peering via a signed invite bundle and used as the trust
anchor for the persistent WebSocket channel.

Invite bundles: a compact base64url blob {v, agent_name, url, ca_pem, sig}
where sig is ECDSA-SHA256 over the canonical fields using the CA private key.
The connecting peer verifies the signature offline before any network call -
MITM is impossible regardless of transport TLS trust.

Challenge/response: on WS connect the initiator sends a peer/hello frame with
a challenge_sig - ECDSA-SHA256 over a nonce using its CA private key. The
acceptor verifies this against the stored CA cert, proving key possession.
"""
import base64
import json
import logging
import os
import threading
import datetime
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

_log = logging.getLogger("porpulsion.tls")


def write_temp_pem(pem_bytes: bytes, name: str) -> str:
    """Write PEM bytes to /tmp/porpulsion-{name}.pem and return the path."""
    path = f"/tmp/porpulsion-{name}.pem"
    with open(path, "wb") as f:
        f.write(pem_bytes)
    os.chmod(path, 0o600)
    return path


def cert_fingerprint(cert_pem: str | bytes) -> str:
    """Return the SHA-256 hex fingerprint of a PEM-encoded certificate."""
    if isinstance(cert_pem, str):
        cert_pem = cert_pem.encode()
    from cryptography.x509 import load_pem_x509_certificate
    cert = load_pem_x509_certificate(cert_pem)
    return cert.fingerprint(hashes.SHA256()).hex()


# ── Invite bundle ─────────────────────────────────────────────────────────────

_BUNDLE_VERSION = 1


def _bundle_signing_data(agent_name: str, url: str, ca_pem: str) -> bytes:
    """Canonical byte string that is signed in an invite bundle."""
    return f"v={_BUNDLE_VERSION}\nagent_name={agent_name}\nurl={url}\nca_pem={ca_pem}".encode()


def sign_bundle(agent_name: str, url: str, ca_pem: str | bytes,
                ca_key_pem: bytes) -> str:
    """
    Build and sign an invite bundle.

    Returns a compact base64url string that the operator copies once and
    pastes into the connecting peer's dashboard.  The bundle contains
    everything needed to establish trust - no separate fingerprint required.
    """
    if isinstance(ca_pem, bytes):
        ca_pem = ca_pem.decode()

    ca_key = serialization.load_pem_private_key(ca_key_pem, password=None)
    data = _bundle_signing_data(agent_name, url, ca_pem)
    sig_bytes = ca_key.sign(data, ec.ECDSA(hashes.SHA256()))

    bundle = {
        "v": _BUNDLE_VERSION,
        "agent_name": agent_name,
        "url": url,
        "ca_pem": ca_pem,
        "sig": base64.b64encode(sig_bytes).decode(),
    }
    return base64.urlsafe_b64encode(json.dumps(bundle, separators=(",", ":")).encode()).decode()


def verify_bundle(bundle_b64: str) -> dict:
    """
    Decode and verify a signed invite bundle.

    Returns {"agent_name", "url", "ca_pem"} on success.
    Raises ValueError with a descriptive message on any failure.
    """
    try:
        raw = base64.urlsafe_b64decode(bundle_b64 + "==")
        bundle = json.loads(raw)
    except Exception as exc:
        raise ValueError(f"bundle decode failed: {exc}") from exc

    if bundle.get("v") != _BUNDLE_VERSION:
        raise ValueError(f"unsupported bundle version: {bundle.get('v')!r}")

    agent_name = bundle.get("agent_name", "")
    url        = bundle.get("url", "")
    ca_pem     = bundle.get("ca_pem", "")
    sig_b64    = bundle.get("sig", "")

    if not all([agent_name, url, ca_pem, sig_b64]):
        raise ValueError("bundle missing required fields")

    try:
        sig_bytes = base64.b64decode(sig_b64)
    except Exception as exc:
        raise ValueError(f"bundle sig decode failed: {exc}") from exc

    try:
        from cryptography.x509 import load_pem_x509_certificate
        ca_cert = load_pem_x509_certificate(ca_pem.encode() if isinstance(ca_pem, str) else ca_pem)
        pub_key = ca_cert.public_key()
        data = _bundle_signing_data(agent_name, url, ca_pem)
        pub_key.verify(sig_bytes, data, ec.ECDSA(hashes.SHA256()))
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"bundle signature invalid: {exc}") from exc

    return {"agent_name": agent_name, "url": url, "ca_pem": ca_pem}


# ── Challenge / response (WS hello frame key-possession proof) ────────────────

def sign_challenge(nonce: str, ca_key_pem: bytes) -> str:
    """
    Sign a nonce with the CA private key.  Used in the peer/hello frame so
    the acceptor can verify the connecting peer actually holds the CA private
    key (not just a copied CA cert).

    Returns base64-encoded DER signature.
    """
    ca_key = serialization.load_pem_private_key(ca_key_pem, password=None)
    sig = ca_key.sign(nonce.encode(), ec.ECDSA(hashes.SHA256()))
    return base64.b64encode(sig).decode()


def verify_challenge(nonce: str, sig_b64: str, ca_pem: str | bytes) -> bool:
    """
    Verify a challenge signature against the peer's CA cert public key.
    Returns True if valid, False otherwise.
    """
    try:
        sig = base64.b64decode(sig_b64)
        from cryptography.x509 import load_pem_x509_certificate
        ca_cert = load_pem_x509_certificate(
            ca_pem.encode() if isinstance(ca_pem, str) else ca_pem)
        ca_cert.public_key().verify(sig, nonce.encode(), ec.ECDSA(hashes.SHA256()))
        return True
    except Exception:
        return False


_CREDENTIALS_SECRET = "porpulsion-credentials"
_PEERS_SECRET       = "porpulsion-peers"


def _k8s_core_v1():
    """Return a CoreV1Api client, loading config lazily."""
    from kubernetes import client, config as kube_config
    try:
        kube_config.load_incluster_config()
    except Exception:
        kube_config.load_kube_config()
    return client.CoreV1Api()


def _patch_secret(core_v1, namespace: str, name: str, data: dict) -> None:
    """Patch (or create) a named Secret with the given base64-encoded data dict."""
    from kubernetes import client as k8s_client
    if not data:
        return
    secret = k8s_client.V1Secret(
        metadata=k8s_client.V1ObjectMeta(name=name, namespace=namespace),
        data=data,
    )
    try:
        core_v1.patch_namespaced_secret(name, namespace, secret)
    except k8s_client.ApiException as e:
        if e.status == 404:
            core_v1.create_namespaced_secret(namespace, secret)
        else:
            raise


def load_or_generate_ca(agent_name: str, namespace: str) -> tuple[bytes, bytes]:
    """
    Load the agent's CA cert + key from the porpulsion-credentials Secret, or
    generate them fresh if absent.  Returns (ca_cert_pem, ca_key_pem) as bytes.

    The CA cert is what peers exchange during peering and is used to authenticate
    the persistent WebSocket channel. The private key never leaves this agent.
    """
    core_v1 = _k8s_core_v1()

    try:
        secret = core_v1.read_namespaced_secret(_CREDENTIALS_SECRET, namespace)
        d = secret.data or {}
        if "ca.crt" in d and "ca.key" in d:
            ca_cert_pem = base64.b64decode(d["ca.crt"])
            ca_key_pem  = base64.b64decode(d["ca.key"])
            _log.info("Loaded existing CA cert from Secret")
            return ca_cert_pem, ca_key_pem
    except Exception:
        pass  # Secret missing or keys absent - generate fresh

    _log.info("Generating new CA for %s", agent_name)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, f"{agent_name}-ca"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "porpulsion"),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, key_cert_sign=True, crl_sign=True,
            content_commitment=False, key_encipherment=False, data_encipherment=False,
            key_agreement=False, encipher_only=False, decipher_only=False,
        ), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    ca_cert_pem = ca_cert.public_bytes(serialization.Encoding.PEM)
    ca_key_pem  = ca_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    try:
        _patch_secret(core_v1, namespace, _CREDENTIALS_SECRET, {
            "ca.crt": base64.b64encode(ca_cert_pem).decode(),
            "ca.key": base64.b64encode(ca_key_pem).decode(),
        })
    except Exception as exc:
        _log.warning("Could not persist CA to Secret: %s", exc)
    return ca_cert_pem, ca_key_pem


# -- Peer persistence

def save_peers(namespace: str, peers: dict) -> None:
    """
    Persist the peers dict to the porpulsion-peers Secret (fire-and-forget thread).
    Serialises each peer as {name, url, ca_pem, direction}.
    """
    peer_list = [
        {"name": p.name, "url": p.url, "ca_pem": p.ca_pem, "direction": p.direction}
        for p in peers.values()
    ]
    json_str = json.dumps(peer_list)

    def _write():
        try:
            core_v1 = _k8s_core_v1()
            _patch_secret(core_v1, namespace, _PEERS_SECRET, {
                "peers": base64.b64encode(json_str.encode()).decode(),
            })
            _log.debug("Persisted %d peer(s) to %s", len(peer_list), _PEERS_SECRET)
        except Exception as exc:
            _log.warning("Could not persist peers to Secret: %s", exc)

    threading.Thread(target=_write, daemon=True).start()


def load_peers(namespace: str) -> list[dict]:
    """
    Load the peers list from the porpulsion-peers Secret.
    Returns [] on missing Secret or any error.
    """
    try:
        core_v1 = _k8s_core_v1()
        secret = core_v1.read_namespaced_secret(_PEERS_SECRET, namespace)
        if not (secret.data and "peers" in secret.data):
            return []
        peer_list = json.loads(base64.b64decode(secret.data["peers"]).decode())
        _log.info("Loaded %d peer(s) from %s", len(peer_list), _PEERS_SECRET)
        return peer_list
    except Exception as exc:
        _log.warning("Could not load peers from Secret: %s", exc)
        return []


# -- State ConfigMap (pending_approval + settings)

_STATE_CONFIGMAP = "porpulsion-state"


def save_state_configmap(namespace: str, settings,
                         pending_approval: dict | None = None) -> None:
    """
    Persist settings and pending_approval to the porpulsion-state ConfigMap
    (fire-and-forget thread).
    """
    from kubernetes import client as k8s_client

    settings_json = json.dumps(settings.to_dict())
    pending_json  = json.dumps(list((pending_approval or {}).values()))

    def _write():
        try:
            core_v1 = _k8s_core_v1()
            cm = k8s_client.V1ConfigMap(
                metadata=k8s_client.V1ObjectMeta(
                    name=_STATE_CONFIGMAP, namespace=namespace),
                data={
                    "settings": settings_json,
                    "pending_approval": pending_json,
                },
            )
            try:
                core_v1.patch_namespaced_config_map(_STATE_CONFIGMAP, namespace, cm)
            except k8s_client.ApiException as e:
                if e.status == 404:
                    core_v1.create_namespaced_config_map(namespace, cm)
                else:
                    raise
            _log.debug("Persisted %d pending approval(s) + settings to ConfigMap",
                       len(pending_approval or {}))
        except Exception as exc:
            _log.warning("Could not persist state to ConfigMap: %s", exc)

    threading.Thread(target=_write, daemon=True).start()


def load_state_configmap(namespace: str) -> dict:
    """
    Load settings and pending_approval from the porpulsion-state ConfigMap.
    Returns {"pending_approval": [...], "settings": {...}} or {} on error.
    """
    try:
        core_v1 = _k8s_core_v1()
        cm = core_v1.read_namespaced_config_map(_STATE_CONFIGMAP, namespace)
        result = {}
        if cm.data and "settings" in cm.data:
            result["settings"] = json.loads(cm.data["settings"])
        if cm.data and "pending_approval" in cm.data:
            result["pending_approval"] = json.loads(cm.data["pending_approval"])
        _log.info("Loaded %d pending approval(s) + settings from ConfigMap",
                  len(result.get("pending_approval", [])))
        return result
    except Exception as exc:
        _log.warning("Could not load state from ConfigMap: %s", exc)
        return {}
