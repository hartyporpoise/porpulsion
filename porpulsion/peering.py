import logging
import time
import threading
import requests
import urllib3
from porpulsion.models import Peer

log = logging.getLogger("porpulsion.peering")


def initiate_peering(agent_name, self_url, peer_url, invite_token,
                     peers, pending_peers, ca_pem_str,
                     expected_ca_fp: str = "", max_retries=30):
    """
    Background thread: keep trying to reach the remote agent until it responds.

    Sends our invite token + CA cert to the remote /peer endpoint over HTTPS
    (verify=False for bootstrap — no CA yet). The remote agent queues this as a
    pending inbound request for their operator to Accept or Reject.
    On 200 we get their CA cert back and transition to awaiting_confirmation.

    pending_peers is mutated: the entry for peer_url is updated with attempt counts
    and removed (by the confirmation handler in agent.py) once fully peered.
    """

    def _attempt():
        from porpulsion import tls
        write_temp_pem = tls.write_temp_pem

        for attempt in range(1, max_retries + 1):
            if peer_url not in pending_peers:
                log.info("Peering to %s cancelled", peer_url)
                return
            pending_peers[peer_url]["attempts"] = attempt

            try:
                urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
                resp = requests.post(
                    f"{peer_url}/peer",
                    json={"name": agent_name, "url": self_url, "ca": ca_pem_str},
                    headers={"X-Invite-Token": invite_token},
                    verify=False,   # bootstrap-only: no CA to verify yet
                    timeout=3,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    peer_name = data.get("name", peer_url)
                    peer_ca   = data.get("ca", "")

                    # Pin the CA fingerprint — abort if it doesn't match what
                    # the operator copied from the peer's Settings page.
                    if expected_ca_fp and peer_ca:
                        from porpulsion.tls import cert_fingerprint
                        actual_fp = cert_fingerprint(peer_ca)
                        if actual_fp != expected_ca_fp:
                            log.error(
                                "CA fingerprint mismatch for %s — possible MITM! "
                                "expected=%s got=%s — aborting peering",
                                peer_url, expected_ca_fp[:16], actual_fp[:16])
                            if peer_url in pending_peers:
                                pending_peers[peer_url]["status"] = "failed"
                                pending_peers[peer_url]["error"]  = "CA fingerprint mismatch — possible MITM"
                            try:
                                from porpulsion.notifications import add_notification
                                add_notification(
                                    level="error",
                                    title="Peering aborted: CA fingerprint mismatch",
                                    message=f"{peer_url} — possible MITM. Expected {expected_ca_fp[:16]}, got {actual_fp[:16]}.",
                                )
                            except Exception:
                                pass
                            return

                    if peer_ca:
                        write_temp_pem(peer_ca.encode(), f"peer-ca-{peer_name}")

                    # Transition to awaiting_confirmation — their operator must
                    # click Accept before the handshake completes.
                    pending_peers[peer_url]["status"] = "awaiting_confirmation"
                    pending_peers[peer_url]["name"]   = peer_name
                    pending_peers[peer_url]["ca_pem"] = peer_ca
                    log.info("Invite delivered to %s — waiting for operator to accept", peer_name)
                    return

                log.warning("Peer rejected our invite (status %s)", resp.status_code)
            except requests.ConnectionError:
                log.debug("Peer %s not up yet (attempt %d/%d)", peer_url, attempt, max_retries)
            # Sleep in short intervals so a cancel is picked up within ~0.2s
            for _ in range(10):
                if peer_url not in pending_peers:
                    log.info("Peering to %s cancelled during wait", peer_url)
                    return
                time.sleep(0.2)

        # Give up — mark as failed so the UI can show a Retry button
        if peer_url in pending_peers:
            pending_peers[peer_url]["status"] = "failed"
            pending_peers[peer_url]["attempts"] = max_retries
        log.error("Failed to reach %s after %d attempts", peer_url, max_retries)
        try:
            from porpulsion.notifications import add_notification
            add_notification(
                level="error",
                title="Peering failed",
                message=f"Could not reach {peer_url} after {max_retries} attempts.",
            )
        except Exception:
            pass

    t = threading.Thread(target=_attempt, daemon=True)
    t.start()


def _extract_client_cert(request) -> str:
    """
    Extract the client certificate PEM from a Flask request.

    Checks two locations in order:
    1. SSL_CLIENT_CERT — injected into the WSGI environ by _MTLSRequestHandler
       when the connection arrives directly on the mTLS port (8443).
    2. X-SSL-Client-Cert HTTP header — set by nginx when it terminates TLS and
       forwards the client cert (nginx ssl_verify_client optional_no_ca +
       proxy_set_header X-SSL-Client-Cert $ssl_client_escaped_cert).
       The cert is URL-encoded in this header, so we decode it first.
    """
    import urllib.parse

    cert = request.environ.get("SSL_CLIENT_CERT", "")
    if cert:
        return cert

    # nginx URL-encodes the PEM (spaces -> +/%, newlines -> %0A etc.)
    header = request.headers.get("X-SSL-Client-Cert", "")
    if header:
        return urllib.parse.unquote(header)

    return ""


def verify_peer(request, peers):
    """
    Verify that a request comes from a known peer via mTLS.

    Supports two transport modes:
    - Direct mTLS (port 8443): client cert is in SSL_CLIENT_CERT environ key.
    - nginx TLS termination: nginx forwards cert via X-SSL-Client-Cert header
      (requires ssl_verify_client optional_no_ca in nginx config).

    Checks that the presented leaf cert was issued by one of our known peer CAs.
    """
    from cryptography.x509 import load_pem_x509_certificate

    client_cert_pem = _extract_client_cert(request)
    if not client_cert_pem:
        log.warning("verify_peer: no client cert presented")
        return False

    # The SSL layer has already verified the chain; just check the issuer DN matches
    # a known peer CA so we know which peer is calling us.
    try:
        leaf = load_pem_x509_certificate(
            client_cert_pem.encode() if isinstance(client_cert_pem, str) else client_cert_pem)
        leaf_issuer_dn = leaf.issuer
    except Exception as exc:
        log.warning("verify_peer: could not parse client cert: %s", exc)
        return False

    for peer in peers.values():
        if not peer.ca_pem:
            continue
        try:
            ca = load_pem_x509_certificate(
                peer.ca_pem.encode() if isinstance(peer.ca_pem, str) else peer.ca_pem)
            if leaf_issuer_dn == ca.subject:
                return True
        except Exception:
            continue

    log.warning("verify_peer: client cert issuer not matched to any known peer CA")
    return False


def identify_peer(request, peers) -> str | None:
    """
    Like verify_peer but returns the peer name instead of True, or None if not verified.
    Used where the caller needs to know *which* peer is calling.
    """
    from cryptography.x509 import load_pem_x509_certificate

    client_cert_pem = _extract_client_cert(request)
    if not client_cert_pem:
        return None

    try:
        leaf = load_pem_x509_certificate(
            client_cert_pem.encode() if isinstance(client_cert_pem, str) else client_cert_pem)
        leaf_issuer_dn = leaf.issuer
    except Exception:
        return None

    for peer in peers.values():
        if not peer.ca_pem:
            continue
        try:
            ca = load_pem_x509_certificate(
                peer.ca_pem.encode() if isinstance(peer.ca_pem, str) else peer.ca_pem)
            if leaf_issuer_dn == ca.subject:
                return peer.name
        except Exception:
            continue

    return None
