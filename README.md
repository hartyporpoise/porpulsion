<p align="center">
  <img src="static/logo.png" width="72" alt="Porpulsion logo" />
</p>

<h1 align="center">Porpulsion</h1>

<p align="center">
  Peer-to-peer Kubernetes connector. Deploy workloads across clusters, open browser tunnels into remote ports, and proxy private images. No VPN, no service mesh, no central control plane.
</p>

---

### Why porpulsion?

Multi-cluster Kubernetes usually means picking between a complex service mesh, a VPN, or handing your credentials to a SaaS control plane. Porpulsion takes a different approach: each cluster runs one small agent pod, and agents talk directly to each other over a persistent mTLS WebSocket. No shared infrastructure to operate, no CNI changes, and it works through NAT and cloud load balancers.

**Good fit for:**
- Teams that need to burst workloads from one cluster to another without full mesh networking
- Running jobs or services on a cluster you do not fully control (co-lo, edge, partner infra)
- Accessing internal web UIs running on a remote cluster without a VPN or `kubectl port-forward`
- Pulling private images from one cluster's registry to another without a public registry

---

Each cluster runs one porpulsion agent. Agents exchange self-signed CA certificates during a one-time peering handshake using a signed invite bundle. After peering, a persistent WebSocket channel carries all inter-agent traffic: RemoteApp submissions, status callbacks, HTTP proxy tunnels, and image pulls. The channel reconnects automatically with exponential backoff if dropped.

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
| `make deploy` | Full two-cluster deploy from scratch (start clusters, build, helm install) |
| `make teardown` | Destroy everything (`docker-compose down -v`) |
| `make status` | Show pods and peer status for both clusters |
| `make logs` | Tail live agent logs from both clusters |
| `make clean-ns` | Remove porpulsion namespace from both clusters |
| `make deploy-single` | Start a single cluster, build, and helm install |
| `make teardown-single` | Destroy the single cluster |
| `make status-single` | Show pods for the single cluster |
| `make logs-single` | Tail agent logs for the single cluster |
| `make test` | Run the full Cypress E2E test suite against the two-cluster local env |
| `make test-teardown` | Destroy everything including Cypress test state |

---

## Production Install

```sh
helm upgrade --install porpulsion oci://ghcr.io/hartyporpoise/charts/porpulsion \
  --create-namespace \
  --namespace porpulsion \
  --set agent.agentName=my-cluster \
  --set agent.websocketDomain=https://porpulsion.example.com \
  --set agent.apiDomain=https://porpulsion.example.com
```

### Port exposure

All traffic is served on a single port. Only **port 8000** needs to be reachable from peers.

| Path | Purpose | Exposure |
|------|---------|----------|
| `/` | Dashboard UI + management API (session auth) | Internal (`kubectl port-forward` or split ingress - behind auth) |
| `/agent/ws` | Peer WebSocket channel | Expose via Ingress |
| `/status` | Health/readiness probes (no auth) | Internal (kubelet only) |

```sh
kubectl port-forward svc/porpulsion 8000:8000 -n porpulsion
```

### Helm values

| Value | Default | Description |
|-------|---------|-------------|
| `agent.agentName` | `""` | Human-readable name shown in the dashboard and used during peering |
| `agent.websocketDomain` | required | Externally reachable URL for the peer WebSocket channel and peering handshake (e.g. `https://porpulsion.example.com`) |
| `agent.apiDomain` | required | Externally reachable URL for the HTTP API and image registry proxy. Usually the same as `websocketDomain`; set differently for split-ingress deployments |
| `agent.image` | `ghcr.io/hartyporpoise/porpulsion:...` | Container image |
| `agent.pullPolicy` | `IfNotPresent` | Image pull policy |
| `agent.allowPvcs` | `false` | Allow inbound apps to request PersistentVolumeClaims |
| `agent.resources` | see values.yaml | CPU/memory requests and limits |
| `service.type` | `ClusterIP` | Use `NodePort` for local dev |
| `service.port` | `8000` | Service port |
| `service.nodePort` | `""` | NodePort value (only when `type=NodePort`) |

Runtime settings (access control, quotas, tunnel permissions) are configured via the dashboard UI or the `/api/settings` endpoint and persisted to the `porpulsion-state` ConfigMap. See `charts/porpulsion/values.yaml` for the full reference.

---

## Usage

### 1. Peer two clusters

On Cluster A, go to **Peers** and copy the invite bundle. On Cluster B, paste it into **Connect a New Peer**. Both sides show the peer as connected within a few seconds.

Peers survive restarts - they are persisted to the `porpulsion-peers` Secret and the WebSocket channel reconnects automatically.

### 2. Deploy a RemoteApp

Go to the **Deploy** page, select a target peer, and fill in the app name and image. Switch to **YAML** mode to submit a full CustomResource:

```yaml
apiVersion: porpulsion.io/v1alpha1
kind: RemoteApp
metadata:
  name: my-app
spec:
  image: nginx:latest
  replicas: 2
  targetPeer: cluster-b
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

The CR is applied on the submitting cluster. A kopf watcher forwards it to the target peer over the WebSocket channel, which creates a Kubernetes Deployment in the `porpulsion` namespace. Status (`Pending` -> `Running`) reflects back automatically.

### 3. Access via HTTP proxy

Navigate to the **Overview** tab on any running app. Click a port URL to reach the app through the WebSocket tunnel. No extra ports need to be opened on the executing cluster. URL rewriting handles root-relative assets, so React, Next.js, and other SPA frameworks work without configuration.

### 4. Stream logs and open a shell

The **Logs** tab streams live pod logs directly from the executing cluster. The **Terminal** tab opens an interactive shell in a running pod (with a shell selector for containers that have multiple options). Both run over the same WebSocket channel, no `kubectl` access to the remote cluster needed.

### 5. Control what runs on your cluster

The executing cluster controls what it accepts. In **Settings** you can:

- Require manual approval before any inbound workload starts
- Set CPU, memory, and replica caps so inbound workloads cannot exceed cluster budget
- Allow or block specific container images using glob patterns
- Restrict tunnel access to specific peers
- Enable PVC support (off by default)

---

## State persistence

| Data | Store |
|------|-------|
| CA cert + key | `porpulsion-credentials` Secret |
| Peers (name, URL, CA cert) | `porpulsion-credentials` Secret |
| Submitted apps | `RemoteApp` CRs (`remoteapps.porpulsion.io`) |
| Executing apps | `ExecutingApp` CRs (`executingapps.porpulsion.io`) |
| Approval queue + runtime settings | `porpulsion-state` ConfigMap |
| User accounts | `porpulsion-users` Secret |

All Secrets and the ConfigMap are created by the Helm chart with `helm.sh/resource-policy: keep` so `helm uninstall` does not wipe credentials or peer data.

---

## CI / Versioning

Versioning is label-driven. Add labels to a PR to trigger version bumps; CI writes the bump commit back to the branch automatically.

### PR labels

| Label | Effect |
|-------|--------|
| `bump:app:patch` | Bumps `appVersion` patch in `Chart.yaml` + image tag in `values.yaml` |
| `bump:app:minor` | Bumps `appVersion` minor |
| `bump:app:major` | Bumps `appVersion` major |
| `bump:chart:patch` | Bumps chart `version` patch in `Chart.yaml` |
| `bump:chart:minor` | Bumps chart `version` minor |
| `bump:chart:major` | Bumps chart `version` major |
| `release-candidate` | Builds and pushes an `rc-X.X.X` Docker image to GHCR |

### Validation rules

- If `charts/porpulsion/files/schema.yaml` changed, a `bump:app:*` label is required or the PR check fails.
- If a `bump:app:*` label is present, a `bump:chart:*` label is also required.

### On merge to `main`

- If `appVersion` changed: a git tag and GitHub release are created, and the Docker image is built and published to GHCR.
- If chart `version` changed: the Helm chart is packaged and pushed to `oci://ghcr.io/hartyporpoise/charts`.

---

## E2E Testing

The full Cypress test suite runs against the two-cluster local environment.

```sh
make deploy      # start clusters (if not already running)
make test        # run all Cypress specs
make test-teardown  # destroy everything when done
```

Tests require the following environment variables (set automatically by `make test`):

| Variable | Description |
|----------|-------------|
| `CYPRESS_AGENT_A_URL` | Base URL for Cluster A (e.g. `http://localhost:8001`) |
| `CYPRESS_AGENT_B_URL` | Base URL for Cluster B (e.g. `http://localhost:8002`) |
| `CYPRESS_USERNAME` | Dashboard login username |
| `CYPRESS_PASSWORD` | Dashboard login password |
