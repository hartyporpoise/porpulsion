# Porpulsion - Claude Code Guide

Porpulsion is a peer-to-peer Kubernetes connector. Each cluster runs one independent Flask agent. Agents peer with each other over mTLS, then communicate over persistent WebSocket channels. There is no central control plane.

---

## Writing Style

- Never use em dashes (--) in code comments, documentation, commit messages, or responses. Use a comma, semicolon, or rewrite the sentence instead.
- Keep responses concise. Lead with the answer, skip preamble.

---

## Architecture

### Single Agent Per Cluster

```
port 8000  Flask HTTP + WebSocket (/agent/ws)
port 8443  Werkzeug mTLS server (initial peering handshake only)
```

`agent.selfUrl` must point to port 8000. This is the URL peers use for both the REST peering invite POST and the persistent WebSocket channel.

### CR-as-Source-of-Truth

**All state changes flow through Kubernetes Custom Resources, never directly.**

- `RemoteApp` CR (submitting side) - created/patched by API routes, watched by kopf handlers, which forward to peer via WS
- `ExecutingApp` CR (executing side) - created by peer channel handler, watched by kopf handlers, which call `run_workload()` in executor

Routes must only create or patch CRs. They must never call channel methods or executor functions directly.

### WebSocket Channel Architecture

After peering, the initiator opens a WS connection to `{peer.url}/agent/ws`. `PeerChannel` wraps this socket, dispatches JSON frames, and auto-reconnects with backoff.

**Message types:** `remoteapp/receive`, `remoteapp/status`, `remoteapp/delete`, `remoteapp/scale`, `remoteapp/detail`, `remoteapp/spec-update`, `proxy/request`, `peer/disconnect`, `ping`

**Key rule:** `peer/disconnect` and soft channel closures must never remove the peer from `state.peers` or the persisted Secret. Only `DELETE /api/peers/<name>` (intentional removal) should wipe a peer.

### State Persistence

Peers are persisted to the `porpulsion-credentials` k8s Secret as JSON. On startup, `agent.py` loads peers then calls `_reconnect_persisted_peers()` after a 3-second delay.

---

## File Map

```
porpulsion/
  agent.py              Flask app startup, blueprint registration, before_request hooks
  state.py              Shared in-memory state: peers, settings, peer_channels
  models.py             Peer, RemoteApp, AgentSettings dataclasses
  channel.py            PeerChannel WebSocket manager
  channel_handlers.py   Handlers for incoming WS message types
  csrf.py               CSRF token generation and validation
  tls.py                CA/leaf cert gen, k8s Secret/ConfigMap persistence
  log_buffer.py         In-memory log buffer (capped at 1000 lines)
  notifications.py      Notification system
  openapi_schemas.py    OpenAPI 3 schema definitions
  openapi_spec.py       OpenAPI spec assembly
  routes/
    auth.py             /login, /logout, /signup, /users/*
    peers.py            /api/peers, /api/invite, /api/peers/connect, /api/peers/<name>
    workloads.py        /api/remoteapp, /api/remoteapps, /api/remoteapp/<id>/*
    tunnels.py          /api/remoteapp/<id>/proxy/* (HTTP reverse proxy over WS)
    settings.py         /api/settings
    logs.py             /api/logs (agent in-process logs)
    notifications.py    /api/notifications, /api/notifications/<id>/*
    ws.py               /agent/ws (WebSocket peer endpoint)
    ui.py               Template routes (/, /peers, /workloads, /deploy, /settings, etc.)
    image_proxy.py      /v2/* (OCI image pull-through proxy)
  k8s/
    executor.py         Creates/updates/deletes K8s Deployments, ConfigMaps, Secrets, PVCs
    store.py            CR lifecycle: create, patch, watch, status updates
    kopf_handlers.py    kopf event watchers for RemoteApp and ExecutingApp CRDs
    tunnel.py           Resolves pod IP, proxies HTTP
    registry_proxy.py   Registry proxy setup and teardown
```

---

## API Routes

All API routes are registered under `/api/` prefix and require authentication (session cookie or HTTP Basic Auth). UI template routes under `/` require session cookie only.

**Auth guard:** `_require_api_auth()` in `agent.py` covers all `/api/` paths.

**CSRF protection:** POST to `/login`, `/logout`, `/signup`, `/users/add`, `/users/edit`, `/users/remove` requires `_csrf_token` form field. API routes do not use CSRF.

### Key response shapes (important for tests)

**`GET /api/remoteapps`** returns an object, not a plain array:
```json
{ "submitted": [...], "executing": [...] }
```
Always spread both when searching: `[...(body.submitted || []), ...(body.executing || [])]`

**`GET /api/invite`** returns:
```json
{ "agent": "agent-name", "self_url": "http://...", "bundle": "...", "cert_fingerprint": "..." }
```
The agent name field is `agent`, not `agentName`. The URL field is `self_url`, not `selfUrl`.

**`GET /api/settings`** returns the `AgentSettings.to_dict()` fields: operational settings like `allow_inbound_remoteapps`, `allow_inbound_tunnels`, resource quotas, etc. It does **not** include `agentName` or `selfUrl`.

**`GET /api/peers`** returns a plain array of peer objects with `name`, `url`, `channel`, `direction`, `latency_ms`, etc.

---

## Kubernetes

### Resource Naming

`safe_resource_name(app_id, app_name)` produces `ea-{id[:8]}-{safe_name}`. Use this for all k8s resources (Deployments, ConfigMaps, Secrets, PVCs).

### CR Watcher Patterns (store.py)

**Generation guard:** Only fire `on_modified` when `metadata.generation` advances. Status-only updates do not increment generation when the CRD has `subresources.status`.

**Bootstrap skip:** CRs created by our code have `porpulsion.io/app-id` label set at creation. `_bootstrap_cr_status` skips these to avoid UUID races.

**ADDED retry:** After ADDED fires, re-fetch the CR up to 5 times with 0.3s sleep until `status.appId` appears.

### schema.yaml

`charts/porpulsion/files/schema.yaml` is the **single source of truth** for the RemoteApp spec. It drives:
- Validation in the agent
- The deploy form UI field generation
- OpenAPI docs

**If `schema.yaml` changes, a `bump:app:*` PR label is required** or CI will block the merge.

---

## Frontend

### Design System (iOS/iPadOS)

- Font: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui`
- Accent: `#0A84FF` (dark) / `#007AFF` (light)
- Surfaces: `--bg: #000` dark / `#F2F2F7` light; `--surface: #1C1C1E` / `#FFFFFF`
- Buttons: solid accent fill, pill shape, `opacity:0.85` hover. No gradients.
- Cards: `border-radius: 12px`, `border: var(--sep) solid var(--border)`. No glass/blur.
- Modals: iOS sheet style (slides up on mobile, scale-in on desktop), 20px radius.
- Confirm dialogs: `#dialog-backdrop` with `#dialog-actions` containing Cancel + OK buttons.

### Key DOM IDs

| ID | Location | Purpose |
|----|----------|---------|
| `#app-modal` | base.html | App detail modal backdrop (`.open` class when visible) |
| `#app-modal-tabs-bar` | base.html | Tab buttons (`[data-tab="overview/logs/terminal/config/edit"]`) |
| `#app-modal-body` | base.html | Tab panels (`[data-panel="..."].active`) |
| `#app-modal-footer` | base.html | Save button area (`#spec-tab-save`, `#cfg-tab-save`) |
| `#modal-spec-textarea` | JS (dynamic) | YAML editor backing textarea in the edit tab |
| `#logs-terminal-wrap` | JS (dynamic) | xterm container for logs tab |
| `#exec-terminal-wrap` | JS (dynamic) | xterm container for terminal tab |
| `#exec-shell-select` | JS (dynamic) | Shell selector in terminal toolbar (native select, hidden by custom dropdown) |
| `#peer-modal` | base.html | Peer detail modal (`.open` class when visible) |
| `#peer-modal-close` | base.html | Close button for peer modal |
| `.peer-info-btn` | JS (dynamic) | Info button on each peer row (opens `#peer-modal`) |
| `#dialog-backdrop` | base.html | Confirm dialog (used by `showConfirm()`) |
| `#dialog-actions` | base.html | Confirm dialog buttons (Cancel first, OK last) |
| `#all-peers-body` | peers.html | Peer table tbody |
| `#all-peers-count` | peers.html | Peer count badge |
| `#invite-bundle` | peers.html | Masked invite bundle span |
| `#new-peer-bundle` | peers.html | Connect form textarea |
| `#connect-peer-form` | peers.html | Peer connect form |
| `#submitted-body` | workloads.html | Submitted apps table tbody |
| `#executing-body` | workloads.html | Executing apps table tbody |
| `#deploy-name` | deploy.html | App name input |
| `#deploy-target-peer` | deploy.html | Target peer select (native `<select>` hidden behind custom dropdown) |
| `#deploy-image` | deploy.html | Container image input |
| `#app-spec-yaml` | deploy.html | Backing textarea (always synced with Monaco) |
| `#toast` | base.html | Global toast notification element |
| `#user-menu-btn` | base.html | User menu toggle button (topbar) |
| `.user-list-row` | users.html | User list row (`<li>`, not `<tr>`) |
| `.btn-icon-danger` | users.html | Delete button in user list rows |
| `.app-detail-btn` | JS (dynamic) | Info button on app rows (opens app modal) |
| `.app-modal-delete-btn` | JS (dynamic) | Delete button inside app modal body |

### Peer Channel Status Badges

The peer channel status badge shows text based on connection type, not the literal word "connected":
- `.badge-mtls` with text "live" -- encrypted (https) peer
- `.badge-pending` with text "local" -- local/private IP peer
- `.badge-failed` with text "offline" -- disconnected peer

**Never check for the text "connected" in peer rows.** Check for `.badge-mtls, .badge-pending` to confirm a live channel.

### Custom Dropdown Overlay

`#deploy-target-peer` is a native `<select>` visually replaced by a custom JavaScript dropdown. Cypress cannot interact with the hidden native element using `.select()` without `{ force: true }`. Use the `cy.selectTargetPeer()` custom command which waits for the option to be populated (async API call) then force-selects it.

### Monaco / Spec Editor

`PorpulsionVscodeEditor` (global) is the Monaco wrapper. Use its API rather than manipulating DOM directly:
- `setDeploySpecValue(yaml)` - set the deploy form YAML
- `getDeploySpecValue()` - read current YAML (prefers Monaco, falls back to `#app-spec-yaml`)
- `initModalSpecEditor(hostId, fallbackId, value, onChange)` - mount editor in modal

`#app-spec-yaml` is always kept in sync and is safe to read. `#app-spec-yaml-fallback` is only visible when Monaco fails to load - do not rely on it.

### Logs and Terminal Rendering

Logs and terminal output are rendered with **xterm.js**, not as plain DOM text. `contain.text('...')` assertions will not find xterm-rendered output. Instead:
- Logs tab: check that `#logs-terminal-wrap` exists inside `[data-panel="logs"]`
- Terminal tab: check that `#exec-terminal-wrap` exists inside `[data-panel="terminal"]`

---

## Cypress E2E Tests

### Test Suite Order

Tests run in filename order. Each spec can depend on the previous ones completing successfully.

```
00-setup.cy.js          Create admin users on both agents (browser UI, handles CSRF)
01-auth.cy.js           Login, logout, user management
02-peering.cy.js        Connect A to B via invite bundle UI
03-workloads.cy.js      Deploy, YAML roundtrip, spec edit, ConfigMap, delete
04-settings.cy.js       Settings page content
05-logs.cy.js           Deploy log-emitting app, verify Logs tab renders xterm
06-terminal.cy.js       Deploy long-running container, verify Terminal tab + shell selector
07-peer-disconnect.cy.js  Peer persistence: channel status badge, info modal, count badge
08-api-health.cy.js     Authenticated API smoke tests on both agents
```

### Rule: New Features Must Have Cypress Tests

**Every new user-visible feature or API endpoint must have corresponding Cypress test coverage.** Add tests to the most relevant existing spec file, or create a new numbered spec if the feature is substantial enough to warrant its own file.

### Custom Commands (cypress/support/e2e.js)

| Command | Purpose |
|---------|---------|
| `cy.loginUI(user?, pass?)` | Browser login via `/login` form. Uses `cy.session` for caching (no cross-spec caching). |
| `cy.loginTo(agentUrl, user?, pass?)` | Cross-origin browser login via `cy.origin`. |
| `cy.apiRequest(method, url, body?)` | HTTP Basic Auth request to `/api/*` endpoints. |
| `cy.selectTargetPeer(peerName)` | Wait for peer option to populate in `#deploy-target-peer`, then force-select it. |
| `cy.openAppModal(appName)` | Click `.app-detail-btn` in the submitted table row, wait for `#app-modal.open`. |
| `cy.appModalTab(tabKey)` | Click a tab in the app modal (`overview/logs/terminal/config/edit`). |
| `cy.confirmDialog()` | Click the OK button (last child) in `#dialog-actions`. |
| `cy.waitForAppPhase(agentUrl, name, phase, attempts?, interval?)` | Poll `/api/remoteapps` (spreads `submitted + executing`) until app reaches phase. |

### Authentication in Tests

- **Browser UI interactions:** use `cy.loginUI()` (stores session cookie via `cy.session`)
- **Cross-origin agent UI:** use `cy.loginTo(agentUrl)` (uses `cy.origin`)
- **API calls (any agent):** use `cy.apiRequest()` (HTTP Basic Auth, no CSRF needed)
- **Never** use raw `cy.request` to POST `/login` - it will return 403 (CSRF protected)
- **Never** assume API endpoints are unauthenticated - all `/api/*` routes require auth

### YAML in Tests

When setting YAML in the deploy form, always use:
```js
cy.window().then((win) => {
  win.PorpulsionVscodeEditor.setDeploySpecValue(yamlString);
});
```

When reading YAML from the deploy form, use `cy.get('#app-spec-yaml').invoke('val')`. Do not use `#app-spec-yaml-fallback` - it is only shown when Monaco fails to load.

### Working with remoteapps API in Tests

`/api/remoteapps` returns `{ submitted: [...], executing: [...] }`, not a plain array. Always combine both lists when searching:

```js
cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
  const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
  const app = all.find((a) => a.name === 'my-app');
});
```

The `cy.waitForAppPhase` command handles this internally.

### Cleanup Pattern in before() Hooks

When a spec deploys apps that may have been left over from a previous run, clean them up in `before()`:

```js
before(() => {
  const CLEANUP = ['app-name-1', 'app-name-2'];
  cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
    const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
    all.forEach((app) => {
      if (CLEANUP.includes(app.name)) {
        const id = app.app_id || app.id;
        if (id) cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
      }
    });
  });
});
```

---

## Release Process

Releases are entirely label-driven via GitHub Actions.

| Label | Effect |
|-------|--------|
| `bump:app:patch/minor/major` | Bumps `appVersion` in Chart.yaml + image tag in values.yaml |
| `bump:chart:patch/minor/major` | Bumps chart version in Chart.yaml |
| `release-candidate` | Builds and pushes `rc-X.X.X` Docker image to GHCR |

**Rules enforced by CI:**
- If `schema.yaml` changes, a `bump:app:*` label is required (blocks merge otherwise)
- If a `bump:app:*` label is present, a `bump:chart:*` label is also required

After merge to `main`:
- If `appVersion` changed: creates GitHub release + builds and publishes the Docker image
- If chart version changed: packages and publishes the Helm chart to GHCR

---

## Local Development

### Two-Cluster Setup (standard)

```bash
make deploy        # Start clusters, build image, helm install on both
make status        # Show pods/deployments/CRs on both clusters
make logs          # Stream live logs from both clusters
make teardown      # Destroy clusters and volumes
```

Cluster A: `http://localhost:8001`
Cluster B: `http://localhost:8002`

### Single-Cluster Setup

```bash
make deploy-single
make status-single
make teardown-single
```

UI + peer: `http://localhost:8080`

### E2E Tests

```bash
make test          # Deploy 2 clusters, run full Cypress suite, tear down
make test-teardown # Destroy clusters if make test was interrupted
```

Screenshots on failure: `cypress/screenshots/`

### selfUrl Notes

`selfUrl` must point to port 8000 (Flask/WS), not port 8443 (mTLS). The Makefile sets `selfUrl=http://$IP:30080` for local dev where `$IP` is the Docker container IP.

---

## Common Pitfalls

**Do not call executor or channel methods directly from routes.** Routes create/patch CRs. kopf handlers react to CR changes and call the appropriate downstream code.

**Do not remove peers on soft disconnect.** `peer/disconnect` WS message and temporary channel failures must never remove the peer from `state.peers` or the Secret. Removal only happens on explicit `DELETE /api/peers/<name>`.

**Generation guard in CR watchers.** Always check `metadata.generation` before processing `on_modified`. Status subresource updates do not increment generation and must be ignored to avoid infinite loops.

**`safe_resource_name` is required.** Never construct k8s resource names manually. Use `safe_resource_name(app_id, app_name)` to guarantee DNS-safe, collision-resistant names.

**schema.yaml changes require a version bump.** The schema is baked into the agent image. Changing it without bumping the app version causes schema/runtime mismatches between agents on different versions.

**CSRF on form POSTs.** Login, logout, signup, and user management routes require `_csrf_token`. API routes do not. Tests must use `cy.loginUI()` or `cy.apiRequest()`, never raw `cy.request` to auth-protected form endpoints.

**`/api/remoteapps` is not a flat array.** It returns `{submitted, executing}`. Any code or test that calls `.find()` directly on `resp.body` will silently fail. Always spread both sub-arrays.

**`/api/settings` has no agentName field.** The agent name is in `/api/invite` (field: `agent`) and in the `{{ agent_name }}` server-rendered template variable. Do not look for `agentName` or `selfUrl` in the settings response.
