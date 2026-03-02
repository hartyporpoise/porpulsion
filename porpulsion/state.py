"""
Shared in-memory state for the porpulsion agent.

All route modules import from here so they share the same live dicts.
Config constants (AGENT_NAME, SELF_URL, etc.) are set once at startup
by porpulsion/agent.py and read by routes at call time.
"""
from typing import TYPE_CHECKING
from porpulsion.models import Peer, RemoteApp, TunnelRequest, AgentSettings
if TYPE_CHECKING:
    from porpulsion.channel import PeerChannel

# ── Runtime config (set by agent.py at startup) ──────────────
AGENT_NAME: str = ""

def _detect_namespace() -> str:
    """Read namespace from the in-cluster service account mount, falling back to 'default'."""
    try:
        with open("/var/run/secrets/kubernetes.io/serviceaccount/namespace") as f:
            return f.read().strip()
    except OSError:
        return "default"

NAMESPACE: str = _detect_namespace()
SELF_URL:   str = ""
AGENT_CA_PEM: bytes = b""
VERSION_HASH: str = ""          # SHA-256 of key protocol files, first 16 hex chars

# ── In-memory state ───────────────────────────────────────────
peers:          dict[str, Peer]          = {}
pending_peers:  dict[str, dict]          = {}   # url  -> {name, url, since, attempts, status, ca_pem}
pending_inbound: dict[str, dict]         = {}   # id   -> {name, url, ca_pem, since}
local_apps:     dict[str, RemoteApp]     = {}   # apps we submitted, tracked locally
remote_apps:    dict[str, RemoteApp]     = {}   # apps received from peers, executing here
pending_approval: dict[str, dict]        = {}   # id -> {id, name, spec, source_peer, callback_url, since}
tunnel_requests: dict[str, TunnelRequest] = {}  # pending/approved/rejected tunnel requests
settings: AgentSettings = AgentSettings()
invite_token: str = ""

# peer_name -> PeerChannel (live WebSocket connection to that peer)
peer_channels: "dict[str, PeerChannel]" = {}

# In-app notifications — newest first, capped at 50
notifications: list[dict] = []
