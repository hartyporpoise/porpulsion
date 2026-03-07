<p align="center">
  <img src="static/logo.png" width="72" alt="Porpulsion logo" />
</p>

<h1 align="center">Porpulsion</h1>

<p align="center">
  Peer-to-peer Kubernetes connector. Deploy workloads across clusters over mutual TLS - no VPN, no service mesh, no central control plane.
</p>

---

```
┌──────────────────────┐                      ┌──────────────────────┐
│  Cluster A           │                      │  Cluster B           │
│  ┌────────────────┐  │  persistent WebSocket │  ┌────────────────┐  │
│  │   porpulsion   │◄─┼──────────────────────┼─►│   porpulsion   │  │
│  │  :8001 peer    │  │  RemoteApp deploy    │  │  :8001 peer    │  │
│  │  :8000 UI+API  │  │  status callbacks    │  │  :8000 UI+API  │  │
│  │  :8002 probes  │  │  HTTP proxy tunnel   │  │  :8002 probes  │  │
│  └────────────────┘  │                      │  └────────────────┘  │
└──────────────────────┘                      └──────────────────────┘
```

Each cluster runs one porpulsion agent. Agents exchange self-signed CA certificates during a one-time peering handshake using a signed invite bundle. After peering, a persistent WebSocket channel carries all inter-agent traffic - RemoteApp submissions, status callbacks, HTTP proxy tunnels. The channel reconnects automatically with exponential backoff if dropped.

---

## Local Development

```sh
git clone https://github.com/hartyporpoise/porpulsion
cd porpulsion
make deploy
```

Starts two k3s clusters and a Helm runner in Docker, builds and loads the image, and Helm-installs porpulsion into both clusters.

| URL | Description |
|-----|-------------|
| `http://localhost:8001` | Cluster A dashboard |
| `http://localhost:8002` | Cluster B dashboard |

**Single cluster** (useful for testing peering from a second machine or another local install):

```sh
make deploy-single   # prompts for an agent name
make redeploy-single # rebuild + upgrade (keeps running cluster)
make teardown-single # destroy
```

### Makefile targets

```sh
make deploy     # Full deploy from scratch (start clusters, build, helm install)
make redeploy   # Rebuild image + helm upgrade (clusters keep running)
make teardown   # Destroy everything (docker-compose down -v)
make status     # Show pods and peer status for both clusters
make logs       # Tail live agent logs from both clusters
make clean-ns   # Remove porpulsion namespace from both clusters
```

---

## Production Install

```sh
helm upgrade --install porpulsion oci://ghcr.io/hartyporpoise/porpulsion \
  --create-namespace \
  --namespace porpulsion \
  --set agent.agentName=my-cluster \
  --set agent.selfUrl=https://porpulsion.example.com
```

### Port exposure

The agent runs three servers. Only **port 8001** should be reachable from the internet.

| Port | Purpose | Exposure |
|------|---------|----------|
| **8000** | Dashboard UI + management API (session auth) | Internal - `kubectl port-forward` only |
| **8001** | Peer WebSocket channel (`/ws`) | Expose via Ingress |
| **8002** | Health/readiness probes (`/status`) - no auth | Internal - kubelet only |

```sh
kubectl port-forward svc/porpulsion 8000:8000 -n porpulsion
```

### nginx Ingress

Two annotations are required:

- **`websocket-services`** - tells nginx to proxy the WebSocket upgrade (sets `Upgrade`/`Connection` headers)
- **`proxy-read-timeout` / `proxy-send-timeout`** - must exceed the agent's ping interval (20 s); default 60 s will drop the channel

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: porpulsion
  namespace: porpulsion
  annotations:
    nginx.ingress.kubernetes.io/websocket-services: "porpulsion"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - porpulsion.example.com
      secretName: porpulsion-tls   # your TLS cert (e.g. cert-manager / Let's Encrypt)
  rules:
    - host: porpulsion.example.com
      http:
        paths:
          - path: /ws
            pathType: Prefix
            backend:
              service:
                name: porpulsion
                port:
                  number: 8001
```

Set `agent.selfUrl` to `https://porpulsion.example.com`. Peers will connect over `wss://` (TLS via nginx). Using `http://` falls back to unencrypted `ws://` - the dashboard shows a yellow warning badge.

### Helm values

| Value | Default | Description |
|-------|---------|-------------|
| `agent.agentName` | `""` | Human-readable name shown in the dashboard and used in peering |
| `agent.selfUrl` | `""` | Externally reachable URL for this agent. Peers use it for the WS channel. Set to your Ingress hostname. Auto-detected if unset (not recommended for production). |
| `agent.image` | `ghcr.io/hartyporpoise/porpulsion:...` | Container image |
| `agent.pullPolicy` | `IfNotPresent` | Image pull policy |
| `agent.allowPvcs` | `false` | Allow inbound apps to request PersistentVolumeClaims |
| `service.type` | `ClusterIP` | Use `NodePort` for local dev |
| `service.port` | `8000` | Dashboard UI + API (internal only) |
| `service.peerPort` | `8001` | Peer WebSocket channel (expose via Ingress) |
| `service.internalPort` | `8002` | Health probes (internal only) |

---

## Usage

### 1 · Peer two clusters

On Cluster A, go to **Peers** and copy the invite bundle. On Cluster B, paste it into **Connect a New Peer**. Both sides show the peer as connected within a few seconds.

Peers survive restarts - they are persisted to the `porpulsion-peers` Secret and the WebSocket channel reconnects automatically.

### 2 · Deploy a RemoteApp

On the **Overview** page, enter an app name and fill in the spec YAML, then click **Deploy to Peer**.

```yaml
image: nginx:latest
replicas: 2
ports:
  - port: 80
    name: http
resources:
  requests:
    cpu: 250m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi
```

The spec is forwarded to the peer over the WebSocket channel, which creates a Kubernetes Deployment in the `porpulsion` namespace. Status (`Pending` → `Running`) reflects back automatically.

### 3 · Access via HTTP proxy

Navigate to the **Proxy** tab on any running app. Click a port URL to reach the app through the WebSocket tunnel - no extra ports need to be opened on the executing cluster.

```
GET /api/remoteapp/<id>/proxy/<port>/
```

---

## State persistence

| Data | Store |
|------|-------|
| CA cert + key | `porpulsion-credentials` Secret |
| Peers (name, URL, CA cert) | `porpulsion-peers` Secret |
| Submitted apps | `RemoteApp` CRs (`remoteapps.porpulsion.io`) |
| Executing apps | `ExecutingApp` CRs (`executingapps.porpulsion.io`) |
| Pending approval queue + settings | `porpulsion-state` ConfigMap |
| User accounts | `porpulsion-users` Secret |

All four Secrets and the ConfigMap are pre-created by the Helm chart with `helm.sh/resource-policy: keep` so `helm uninstall` does not wipe credentials or peer data.
