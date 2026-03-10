<p align="center">
  <img src="static/logo.png" width="72" alt="Porpulsion logo" />
</p>

<h1 align="center">Porpulsion</h1>

<p align="center">
  Peer-to-peer Kubernetes connector. Deploy workloads across clusters over mutual TLS. No VPN, no service mesh, no central control plane.
</p>

---

Each cluster runs one porpulsion agent. Agents exchange self-signed CA certificates during a one-time peering handshake using a signed invite bundle. After peering, a persistent WebSocket channel carries all inter-agent traffic: RemoteApp submissions, status callbacks, and HTTP proxy tunnels. The channel reconnects automatically with exponential backoff if dropped.

---

## Local Development

```sh
git clone https://github.com/hartyporpoise/porpulsion
cd porpulsion
make deploy
```

Starts two k3s clusters in Docker, builds and loads the image, and Helm-installs porpulsion into both clusters.

| URL | Description |
|-----|-------------|
| `http://localhost:8001` | Cluster A dashboard |
| `http://localhost:8002` | Cluster B dashboard |

**Single cluster** (useful for testing peering from a second machine or another local install):

```sh
make deploy-single   # start cluster, build, helm install
make teardown-single # destroy cluster
```

### Makefile targets

| Target | Description |
|--------|-------------|
| `make deploy` | Full deploy from scratch (start clusters, build, helm install) |
| `make teardown` | Destroy everything (`docker-compose down -v`) |
| `make status` | Show pods and peer status for both clusters |
| `make logs` | Tail live agent logs from both clusters |
| `make clean-ns` | Remove porpulsion namespace from both clusters |

---

## Production Install

```sh
helm upgrade --install porpulsion oci://ghcr.io/hartyporpoise/charts/porpulsion \
  --create-namespace \
  --namespace porpulsion \
  --set agent.agentName=my-cluster \
  --set agent.selfUrl=https://porpulsion.example.com
```

### Port exposure

All traffic is served on a single port. Only **port 8000** needs to be reachable from peers.

| Path | Purpose | Exposure |
|------|---------|----------|
| `/` | Dashboard UI + management API (session auth) | Internal (`kubectl port-forward` or split ingress - behind auth) |
| `/ws` | Peer WebSocket channel | Expose via Ingress |
| `/status` | Health/readiness probes (no auth) | Internal (kubelet only) |

```sh
kubectl port-forward svc/porpulsion 8000:8000 -n porpulsion
```

### Helm values

| Value | Default | Description |
|-------|---------|-------------|
| `agent.agentName` | `""` | Human-readable name shown in the dashboard and used during peering |
| `agent.selfUrl` | `""` | Externally reachable URL for this agent. Peers use it for the WebSocket channel. Set to your Ingress hostname. |
| `agent.image` | `ghcr.io/hartyporpoise/porpulsion:...` | Container image |
| `agent.pullPolicy` | `IfNotPresent` | Image pull policy |
| `agent.allowPvcs` | `false` | Allow inbound apps to request PersistentVolumeClaims |
| `agent.resources` | see values.yaml | CPU/memory requests and limits |
| `service.type` | `ClusterIP` | Use `NodePort` for local dev |
| `service.port` | `8000` | Service port |
| `service.nodePort` | `""` | NodePort value (only when `type=NodePort`) |

Runtime settings (access control, quotas, tunnel permissions) are configured via the dashboard UI or the `/settings` API and persisted to the `porpulsion-state` ConfigMap. See `charts/porpulsion/values.yaml` for the full reference.

---

## Usage

### 1. Peer two clusters

On Cluster A, go to **Peers** and copy the invite bundle. On Cluster B, paste it into **Connect a New Peer**. Both sides show the peer as connected within a few seconds.

Peers survive restarts - they are persisted to the `porpulsion-peers` Secret and the WebSocket channel reconnects automatically.

### 2. Deploy a RemoteApp

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

The spec is forwarded to the peer over the WebSocket channel, which creates a Kubernetes Deployment in the `porpulsion` namespace. Status (`Pending` -> `Running`) reflects back automatically.

### 3. Access via HTTP proxy

Navigate to the **Proxy** tab on any running app. Click a port URL to reach the app through the WebSocket tunnel - no extra ports need to be opened on the executing cluster.

---

## State persistence

| Data | Store |
|------|-------|
| CA cert + key | `porpulsion-credentials` Secret |
| Peers (name, URL, CA cert) | `porpulsion-peers` Secret |
| Submitted apps | `RemoteApp` CRs (`remoteapps.porpulsion.io`) |
| Executing apps | `ExecutingApp` CRs (`executingapps.porpulsion.io`) |
| Approval queue + runtime settings | `porpulsion-state` ConfigMap |
| User accounts | `porpulsion-users` Secret |

All Secrets and the ConfigMap are created by the Helm chart with `helm.sh/resource-policy: keep` so `helm uninstall` does not wipe credentials or peer data.

---

## CI / Versioning

PRs are versioned automatically based on commit message prefixes. The version bump commit is added to the PR branch and does not re-trigger CI.

| Prefix | App version | Chart version |
|--------|-------------|---------------|
| `[major]` | major bump | major bump |
| `[minor]` | minor bump | minor bump |
| `[bugfix]` / `[schema]` | patch bump | patch bump |
| `[chart]` | no change | patch bump |

On merge to `main`, if `appVersion` changed the Docker image is built and published to GHCR and a GitHub release is created. If `version` changed the Helm chart is packaged and pushed to `oci://ghcr.io/hartyporpoise/charts`.
