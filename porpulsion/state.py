"""
Shared in-memory state for the porpulsion agent.

All route modules import from here so they share the same live dicts.
Config constants (AGENT_NAME, SELF_URL, etc.) are set once at startup
by porpulsion/agent.py and read by routes at call time.
"""
import threading
from typing import TYPE_CHECKING
from porpulsion.models import Peer, TunnelRequest, AgentSettings
if TYPE_CHECKING:
    from porpulsion.channel import PeerChannel

# -- Runtime config (set by agent.py at startup)
AGENT_NAME: str = ""

def _detect_namespace() -> str:
    """Read namespace from the in-cluster service account mount, falling back to 'default'."""
    try:
        with open("/var/run/secrets/kubernetes.io/serviceaccount/namespace") as f:
            return f.read().strip()
    except OSError:
        return "default"

NAMESPACE: str = _detect_namespace()
SELF_URL:      str   = ""
AGENT_CA_PEM:     bytes = b""
AGENT_CA_KEY_PEM: bytes = b""   # CA private key — used to sign invite bundles and hello challenges
VERSION_HASH: str = ""          # SHA-256 of key protocol files, first 16 hex chars

# -- In-memory state
peers:          dict[str, Peer]          = {}
pending_peers:  dict[str, dict]          = {}   # url  -> {name, url, since, attempts, status, ca_pem}
# NOTE: local_apps and remote_apps have been removed.
#       App state is now stored in k8s CRs (RemoteApp / ExecutingApp).
#       Use porpulsion.k8s.store.list_remoteapp_crs() and list_executingapp_crs() instead.
pending_approval: dict[str, dict]        = {}   # id -> {id, name, spec, source_peer, callback_url, since}
tunnel_requests: dict[str, TunnelRequest] = {}  # pending/approved/rejected tunnel requests
settings: AgentSettings = AgentSettings()

# peer_name -> PeerChannel (live WebSocket connection to that peer)
# Access must be guarded by peer_channels_lock when adding/removing entries.
# Simple reads (get, iteration) from the same thread are safe without the lock,
# but any structural mutation (open, replace, remove) must hold the lock.
peer_channels: "dict[str, PeerChannel]" = {}
peer_channels_lock: threading.Lock = threading.Lock()

# In-app notifications - newest first, capped at 50
notifications: list[dict] = []


def registry_proxy_url() -> str:
    """
    Return the full URL for this agent's image proxy endpoint.
    Uses registry_api_url override if set (split-ingress), otherwise SELF_URL.
    Returns "" if registry_pull_enabled is False.
    """
    if not settings.registry_pull_enabled:
        return ""
    base = (settings.registry_api_url or "").strip().rstrip("/") or SELF_URL.rstrip("/")
    return base if base else ""
