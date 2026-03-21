/**
 * Porpulsion dashboard — page refresh, render, form bindings.
 * Depends on window.Porpulsion (api.js + app.js). Uses /api for all requests.
 */
(function () {
  'use strict';
  var P = window.Porpulsion;
  if (!P) return;

  var _esc = P.esc;
  var statusBadge = P.statusBadge;
  var timeAgo = P.timeAgo;
  var toast = P.toast;
  var API_BASE = P.API_BASE;

  function el(id) { return document.getElementById(id); }

  // Cache of last-fetched workloads for use in confirmation dialogs
  var _lastSubmitted = [];
  var _lastExecuting = [];

  var _proxyDomain = '';

  function initDeploySpecEditor() {
    if (window.PorpulsionVscodeEditor && typeof window.PorpulsionVscodeEditor.initDeploySpecEditor === 'function') {
      window.PorpulsionVscodeEditor.initDeploySpecEditor();
    }
  }

  function setDeploySpecValue(nextValue) {
    if (window.PorpulsionVscodeEditor && typeof window.PorpulsionVscodeEditor.setDeploySpecValue === 'function') {
      window.PorpulsionVscodeEditor.setDeploySpecValue(nextValue);
    } else {
      var yamlEl = el('app-spec-yaml');
      if (yamlEl) yamlEl.value = nextValue;
    }
  }

  function populateTargetPeerSelect(peers) {
    var sel = el('app-target-peer');
    if (!sel) return;
    // Only show outgoing/bidirectional peers — incoming-only peers cannot receive deployments
    var deployable = peers.filter(function (p) {
      return 'channel' in p && (p.direction === 'outgoing' || p.direction === 'bidirectional');
    });
    var prev = sel.value;
    sel.innerHTML = '<option value="" disabled hidden>— select peer —</option>';
    deployable.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.channel === 'connected' ? p.name : p.name + ' (reconnecting)';
      sel.appendChild(opt);
    });
    // Restore previous selection if still valid
    if (prev && deployable.some(function (p) { return p.name === prev; })) {
      sel.value = prev;
    } else if (deployable.length === 1) {
      sel.value = deployable[0].name;
    }
  }

  function renderOverviewPeers(peers) {
    var body = el('overview-peers-body');
    var empty = el('overview-peers-empty');
    var badge = el('peers-count-badge');
    if (!body) return;
    var connected = peers.filter(function (p) { return 'channel' in p; });
    if (badge) badge.textContent = connected.length;
    if (!connected.length) { body.innerHTML = ''; if (empty) empty.style.display = ''; return; }
    if (empty) empty.style.display = 'none';
    body.innerHTML = connected.map(function (p) {
      var wsConn = p.channel === 'connected';
      var chanBadge = wsConn ? channelBadge(p.url) : '<span class="badge badge-failed">offline</span>';
      var dirBadge = directionBadge(p.direction);
      return '<tr><td><strong>' + _esc(p.name) + '</strong></td><td class="mono">' + _esc(p.url || '') + '</td><td>' + chanBadge + '</td><td>' + dirBadge + '</td><td class="time-ago">' + timeAgo(p.connected_at) + '</td></tr>';
    }).join('');
  }

  function isPrivateUrl(url) {
    try {
      var h = new URL(url).hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
             /^10\./.test(h) || /^192\.168\./.test(h) ||
             /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    } catch (e) { return false; }
  }

  function channelBadge(url) {
    var encrypted = (url || '').indexOf('https://') === 0;
    var local = isPrivateUrl(url || '');
    if (encrypted)
      return '<span class="badge badge-mtls"><span class="badge-dot"></span>live</span>';
    if (local)
      return '<span class="badge badge-pending"><span class="badge-dot"></span>local</span>';
    return '<span class="badge badge-warn"><span class="badge-dot"></span>live</span>';
  }

  function directionBadge(dir) {
    if (dir === 'bidirectional') return '<span class="badge badge-mtls">&#8644; bidirectional</span>';
    if (dir === 'incoming')     return '<span class="badge badge-pending">&#8592; incoming</span>';
    return '<span class="badge badge-handshake">&#8594; outgoing</span>';
  }

  var ICON_INFO = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8.5"/><line x1="12" y1="12" x2="12" y2="16"/></svg>';
  var ICON_TRASH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

  function renderAllPeers(peers) {
    window._lastPeers = peers;
    var body = el('all-peers-body');
    var empty = el('all-peers-empty');
    var countEl = el('all-peers-count');
    if (!body) return;
    if (countEl) countEl.textContent = peers.length;
    if (!peers.length) { body.innerHTML = ''; if (empty) empty.style.display = ''; return; }
    if (empty) empty.style.display = 'none';
    body.innerHTML = peers.map(function (p) {
      var chanHtml = (p.channel === 'connected')
        ? channelBadge(p.url)
        : '<span class="badge badge-failed">offline</span>';
      var dirBadge = directionBadge(p.direction);
      var latencyCell = (p.latency_ms != null)
        ? '<span class="peer-latency ' + (p.latency_ms < 50 ? 'lat-good' : p.latency_ms < 200 ? 'lat-warn' : 'lat-bad') + '">' + p.latency_ms + ' ms</span>'
        : '<span class="text-muted" style="font-size:0.8rem;">—</span>';
      var actions = '<span class="btn-row">' +
        '<button type="button" class="btn-icon peer-info-btn" title="Info" aria-label="Info">' + ICON_INFO + '</button>' +
        '<button type="button" class="btn-icon btn-icon-danger peer-remove-btn" title="Remove" aria-label="Remove">' + ICON_TRASH + '</button>' +
        '</span>';
      return '<tr data-peer-url="' + _esc(p.url) + '" data-peer-name="' + _esc(p.name) + '">' +
        '<td><strong>' + _esc(p.name) + '</strong></td>' +
        '<td class="mono col-hide-tablet">' + _esc(p.url || '') + '</td>' +
        '<td class="col-hide-mobile">' + dirBadge + '</td>' +
        '<td>' + chanHtml + '</td>' +
        '<td class="col-hide-mobile">' + latencyCell + '</td>' +
        '<td class="time-ago col-hide-tablet">' + timeAgo(p.connected_at) + '</td>' +
        '<td>' + actions + '</td></tr>';
    }).join('');
  }

  function openPeerModal(peerName) {
    var modal = el('peer-modal');
    var title = el('peer-modal-title');
    var body = el('peer-modal-body');
    var removeBtn = el('peer-modal-remove-btn');
    if (!modal || !body) return;

    var peers = (window._lastPeers || []);
    var p = peers.filter(function (x) { return x.name === peerName; })[0];

    if (title) title.textContent = peerName;
    if (removeBtn) {
      removeBtn.onclick = function () {
        modal.classList.remove('open');
        showPeerRemoveConfirm(peerName, function () { removePeer(peerName); });
      };
    }

    if (!p) { body.innerHTML = '<p class="text-muted text-sm">Not found.</p>'; modal.classList.add('open'); return; }

    var latencyRow = (p.latency_ms != null)
      ? '<div class="detail-row"><span class="label">Latency</span><span>' + p.latency_ms + ' ms</span></div>'
      : '';
    var versionRow = p.version_hash
      ? '<div class="detail-row"><span class="label">Version</span><span class="mono" style="font-size:0.8rem;">' + _esc(p.version_hash) + '</span></div>'
      : '';
    var crdDiff = p.crd_diff;
    var crdRow = '';
    if (crdDiff && ((crdDiff.missing_local && crdDiff.missing_local.length) || (crdDiff.missing_remote && crdDiff.missing_remote.length))) {
      var parts = [];
      if (crdDiff.missing_remote && crdDiff.missing_remote.length) parts.push('peer missing: ' + crdDiff.missing_remote.join(', '));
      if (crdDiff.missing_local && crdDiff.missing_local.length) parts.push('missing: ' + crdDiff.missing_local.join(', '));
      crdRow = '<div class="detail-row"><span class="label">CRD diff</span><span class="text-sm" style="color:var(--yellow);">' + _esc(parts.join(' | ')) + '</span></div>';
    }

    var remoteAddrRow = p.remote_addr
      ? '<div class="detail-row"><span class="label">Public IP</span><span class="mono" style="font-size:0.85rem;">' + _esc(p.remote_addr) + '</span></div>'
      : '';
    var proxyRow = p.registry_proxy_url
      ? '<div class="detail-row"><span class="label">API Domain</span><span class="mono" style="font-size:0.82rem;word-break:break-all;">' + _esc(p.registry_proxy_url.replace(/^https?:\/\//, '')) + '</span></div>'
      : '';

    body.innerHTML =
      '<div class="detail-block" style="border:none;padding-top:0;">' +
        '<div class="detail-row"><span class="label">URL</span><span class="mono" style="font-size:0.82rem;word-break:break-all;">' + _esc(p.url || '-') + '</span></div>' +
        remoteAddrRow +
        proxyRow +
        '<div class="detail-row"><span class="label">Direction</span><span>' + directionBadge(p.direction) + '</span></div>' +
        '<div class="detail-row"><span class="label">Status</span><span>' + (p.channel === 'connected' ? channelBadge(p.url) : '<span class="badge badge-failed">offline</span>') + '</span></div>' +
        latencyRow +
        '<div class="detail-row"><span class="label">Connected</span><span>' + timeAgo(p.connected_at) + '</span></div>' +
        versionRow +
        crdRow +
      '</div>';

    modal.classList.add('open');
  }


  function renderRecentApps(submitted, executing) {
    var body = el('recent-apps-body');
    var empty = el('recent-apps-empty');
    var countEl = el('recent-apps-count');
    if (!body) return;
    var all = submitted.map(function (a) { return Object.assign({}, a, { _type: 'submitted' }); }).concat(executing.map(function (a) { return Object.assign({}, a, { _type: 'executing' }); }));
    all.sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
    all = all.slice(0, 8);
    if (countEl) countEl.textContent = all.length;
    if (!all.length) { body.innerHTML = ''; if (empty) empty.style.display = ''; return; }
    if (empty) empty.style.display = 'none';
    body.innerHTML = all.map(function (a) {
      var typeLabel = a._type === 'submitted' ? '<span class="badge badge-handshake" style="font-size:0.65rem;">remote</span>' : '<span class="badge badge-inbound" style="font-size:0.65rem;">executing</span>';
      return '<tr data-app-id="' + _esc(a.id) + '" data-app-name="' + _esc(a.name) + '" data-app-type="' + a._type + '">' +
        '<td><a href="#" class="app-open-link">' + _esc(a.name) + '</a></td>' +
        '<td>' + typeLabel + '</td><td>' + statusBadge(a.status) + '</td>' +
        '<td class="time-ago">' + timeAgo(a.updated_at) + '</td>' +
        '<td><span class="btn-row"><button type="button" class="btn-icon app-detail-btn" title="Detail" aria-label="Detail"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8.5"/><line x1="12" y1="12" x2="12" y2="16"/></svg></button><button type="button" class="btn-icon app-restart-btn" title="Rollout restart" aria-label="Rollout restart"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button></span></td></tr>';
    }).join('');
  }

  function renderApps(list, bodyId, emptyId, countId, showSource, appType) {
    var body = el(bodyId);
    if (!body) return;
    var empty = el(emptyId);
    var countEl = countId ? el(countId) : null;
    if (countEl) countEl.textContent = list.length;
    if (!list.length) { body.innerHTML = ''; if (empty) empty.style.display = ''; return; }
    if (empty) empty.style.display = 'none';
    var peerKey = showSource ? 'source_peer' : 'target_peer';
    var typeAttr = appType ? ' data-app-type="' + appType + '"' : '';
    body.innerHTML = list.map(function (a) {
      var isDead = a.status === 'Deleted' || a.status === 'Failed' || a.status === 'Timeout';
      var peerVal = a[peerKey] || '—';
      var restartBtn = isDead ? '' : '<button type="button" class="btn-icon app-restart-btn" title="Rollout restart" aria-label="Rollout restart"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>';
      return '<tr' + (isDead ? ' style="opacity:0.55;"' : '') + ' data-app-id="' + _esc(a.id) + '" data-app-name="' + _esc(a.name) + '"' + typeAttr + '>' +
        '<td><a href="#" class="app-open-link">' + _esc(a.name) + '</a></td>' +
        '<td class="mono col-hide-mobile">' + _esc(a.id) + '</td><td>' + statusBadge(a.status) + '</td>' +
        '<td class="text-muted text-sm col-hide-tablet">' + _esc(peerVal) + '</td>' +
        '<td class="time-ago col-hide-tablet">' + timeAgo(a.updated_at) + '</td>' +
        '<td><span class="btn-row"><button type="button" class="btn-icon app-detail-btn" title="Detail" aria-label="Detail"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8.5"/><line x1="12" y1="12" x2="12" y2="16"/></svg></button>' + restartBtn + '</span></td></tr>';
    }).join('');
  }

  function _proxySetupInstructions(appName, port) {
    return '<div class="proxy-setup-instructions">' +
      '<div class="proxy-setup-section">' +
        '<div class="proxy-setup-heading">Standard DNS (one wildcard CNAME)</div>' +
        '<code class="proxy-setup-code mono">*.' + _esc(_proxyDomain) + '  CNAME  ' + _esc(_proxyDomain) + '</code>' +
      '</div>' +
      '<div class="proxy-setup-section">' +
        '<div class="proxy-setup-heading">Cloudflare Tunnel</div>' +
        '<div class="proxy-setup-cf">In your CF Tunnel config, add a Public Hostname:</div>' +
        '<code class="proxy-setup-code mono">Subdomain: ' + _esc(appName + '-' + port) + '<br>Domain: ' + _esc(_proxyDomain) + '<br>Service: http://localhost:8000</code>' +
      '</div>' +
    '</div>';
  }

  function renderProxyApps(submitted) {
    var listEl = el('proxy-apps-list');
    if (!listEl) return;
    var active = submitted.filter(function (a) { return a.status !== 'Deleted' && a.status !== 'Failed' && a.status !== 'Timeout'; });
    if (!active.length) {
      listEl.innerHTML = '<div class="empty-state" style="padding:3rem 1rem;"><div class="empty-icon">&#8658;</div>No submitted apps yet — <a href="/deploy">deploy a workload</a></div>';
      return;
    }
    var ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    var ICON_OPEN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    var ICON_DETAIL = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8.5"/><line x1="12" y1="12" x2="12" y2="16"/></svg>';
    var noDomain = !_proxyDomain;
    listEl.innerHTML = active.map(function (a) {
      var isDead = a.status === 'Deleted' || a.status === 'Failed' || a.status === 'Timeout';
      var ports = (a.spec && Array.isArray(a.spec.ports) && a.spec.ports.length) ? a.spec.ports : [{ port: (a.spec && a.spec.port) || 80 }];
      var portRows = ports.map(function (p) {
        var portNum = typeof p === 'object' ? (p.port || 80) : p;
        var portLabel = (p.name ? p.name : 'Port ' + portNum);
        var setupId = 'proxy-setup-' + a.id + '-' + portNum;
        if (noDomain) {
          return '<div class="proxy-port-row">' +
            '<span class="proxy-port-label">' + _esc(portLabel) + ' <span class="mono" style="font-size:0.7rem;color:var(--muted2);">:' + portNum + '</span></span>' +
            '<span class="proxy-port-url text-muted" style="font-size:0.7rem;">Set <span class="mono">apiDomain</span> in Helm values to enable CNAME access</span>' +
            '</div>';
        }
        var hostname = a.name + '-' + portNum + '.' + _proxyDomain;
        var copyId = 'proxy-url-' + a.id + '-' + portNum;
        var openBtn = !isDead
          ? '<a href="' + _esc('https://' + hostname) + '" target="_blank" rel="noopener" class="btn-sm proxy-open-btn" title="Open :' + portNum + '">' + ICON_OPEN + ' Open</a>'
          : '';
        return '<div class="proxy-port-row">' +
          '<span class="proxy-port-label">' + _esc(portLabel) + ' <span class="mono" style="font-size:0.7rem;color:var(--muted2);">:' + portNum + '</span></span>' +
          '<span id="' + copyId + '" class="proxy-port-url mono" style="font-size:0.7rem;color:var(--muted);" title="' + _esc(hostname) + '">' + _esc(hostname) + '</span>' +
          '<button type="button" class="btn-icon" title="Copy hostname" aria-label="Copy hostname" data-copy-el="' + copyId + '">' + ICON_COPY + '</button>' +
          openBtn +
          '<button type="button" class="btn-sm proxy-setup-toggle" aria-expanded="false" data-target="' + setupId + '" style="margin-left:0.25rem;">Setup</button>' +
          '</div>' +
          '<div id="' + setupId + '" class="proxy-setup-wrap" style="display:none;">' + _proxySetupInstructions(a.name, portNum) + '</div>';
      }).join('');
      return '<div class="proxy-app-entry">' +
        '<div class="proxy-app-name">' +
        '<strong>' + _esc(a.name) + '</strong>' +
        statusBadge(a.status) +
        '<span class="text-muted text-sm" style="margin-left:auto;font-size:0.75rem;">' + _esc(a.target_peer || '') + '</span>' +
        '<button type="button" class="btn-icon app-detail-btn" title="Detail" aria-label="Detail" data-app-id="' + _esc(a.id) + '">' + ICON_DETAIL + '</button>' +
        '</div>' + portRows + '</div>';
    }).join('');

    // Wire setup toggle buttons
    var toggles = listEl.querySelectorAll('.proxy-setup-toggle');
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].addEventListener('click', function () {
        var targetId = this.getAttribute('data-target');
        var wrap = el(targetId);
        if (!wrap) return;
        var open = wrap.style.display !== 'none';
        wrap.style.display = open ? 'none' : 'block';
        this.setAttribute('aria-expanded', open ? 'false' : 'true');
        this.textContent = open ? 'Setup' : 'Hide';
      });
    }
  }

  function renderApproval(list) {
    var banner = el('approval-banner');
    var listEl = el('approval-list');
    var badge = el('nav-approval-badge');
    if (!banner) return;
    if (!list.length) {
      banner.classList.remove('visible');
      if (badge) badge.style.display = 'none';
      if (listEl) listEl.innerHTML = '';
      return;
    }
    banner.classList.add('visible');
    if (badge) { badge.style.display = ''; badge.textContent = list.length; }
    if (!listEl) return;
    listEl.innerHTML = list.map(function (r) {
      var id = r.id;
      var spec = r.spec || {};
      var image = spec.image || '';
      var replicas = spec.replicas || 1;
      return '<div class="approval-item">' +
        '<div class="approval-item-header">' +
        '<div class="approval-item-info">' +
        '<div class="approval-item-name">' + _esc(r.name || id) + '</div>' +
        '<div class="approval-item-meta">from <strong>' + _esc(r.source_peer || '?') + '</strong>' + (image ? ' · <span class="mono">' + _esc(image) + '</span>' : '') + ' · ' + replicas + ' replica(s)</div></div>' +
        '<div class="approval-item-time">' + timeAgo(r.since) + '</div>' +
        '<div class="btn-row">' +
        '<button type="button" class="btn-sm btn-success" data-approve-app="' + _esc(id) + '" data-approve-name="' + _esc(r.name || id) + '">Approve</button>' +
        '<button type="button" class="btn-sm btn-danger" data-reject-app="' + _esc(id) + '">Reject</button></div></div>' +
        '<div class="approval-item-spec"><pre class="approval-spec-pre">' + _esc(JSON.stringify(spec, null, 2)) + '</pre></div></div>';
    }).join('');
  }

  function refresh() {
    P.getNotifications().then(renderNotifications).catch(function () {});
    Promise.all([
      P.getPeers(),
      P.getRemoteApps(),
      P.getPendingApproval().catch(function () { return []; })
    ]).then(function (results) {
      var peers = results[0];
      var apps = results[1];
      var approval = results[2];
      var submitted = apps.submitted || [];
      var executing = apps.executing || [];
      _lastSubmitted = submitted;
      _lastExecuting = executing;
      var connected = peers.filter(function (p) { return 'channel' in p; });
      var wsUp = connected.filter(function (p) { return p.channel === 'connected'; }).length;

      function setStat(id, val) {
        var e = el(id);
        if (!e) return;
        e.classList.remove('loading');
        e.textContent = val;
      }
      setStat('stat-peers', connected.length);
      setStat('stat-submitted', submitted.length);
      setStat('stat-executing', executing.length);

      var healthy = submitted.concat(executing).filter(function (a) { return a.status === 'Ready' || a.status === 'Running'; }).length;
      setStat('stat-healthy', healthy);
      var statHealthySub = el('stat-healthy-sub');
      if (statHealthySub) statHealthySub.textContent = healthy === 1 ? 'app ready' : 'apps ready';

      var connecting = peers.filter(function (p) { return p.status === 'connecting'; }).length;
      var sub = [];
      if (connecting) sub.push(connecting + ' connecting');
      if (wsUp < connected.length && connected.length > 0) sub.push((connected.length - wsUp) + ' reconnecting');
      var statSub = el('stat-peers-sub');
      if (statSub) statSub.textContent = sub.length ? sub.join(', ') : (connected.length ? 'all connected' : 'no peers');

      var peerLabel = el('peer-count-label');
      if (peerLabel) {
        var reconnecting = connected.length - wsUp;
        var meshCls, meshDot, meshText;
        if (!connected.length) {
          meshCls = 'mesh-pill mesh-pill-grey'; meshDot = '○'; meshText = 'No peers';
        } else if (reconnecting > 0 || connecting > 0) {
          meshCls = 'mesh-pill mesh-pill-yellow'; meshDot = '◐';
          meshText = wsUp + '/' + connected.length + ' peer' + (connected.length !== 1 ? 's' : '');
        } else {
          meshCls = 'mesh-pill mesh-pill-green'; meshDot = '●';
          meshText = connected.length + ' peer' + (connected.length !== 1 ? 's' : '');
        }
        peerLabel.innerHTML = '<span class="' + meshCls + '"><span class="mesh-dot">' + meshDot + '</span>' + meshText + '</span>';
      }

      renderOverviewPeers(peers);
      renderAllPeers(peers);
      populateTargetPeerSelect(peers);
      _syncTunnelPeersFromData(peers);
      renderApproval(approval);
      renderRecentApps(submitted, executing);
      renderApps(submitted, 'submitted-body', 'submitted-empty', 'submitted-count', false, 'submitted');
      renderApps(executing, 'executing-body', 'executing-empty', 'executing-count', true, 'executing');
      renderProxyApps(submitted);

      // If a modal is open, re-evaluate the config tab's disabled state
      if (_currentAppId) {
        var allApps = submitted.concat(executing);
        var modalApp = allApps.filter(function (a) { return a.id === _currentAppId; })[0];
        if (modalApp) {
          var ready = modalApp.status === 'Running' || modalApp.status === 'Ready';
          var modalBody = el('app-modal-body');
          var cfgTab = modalBody ? modalBody.querySelector('[data-tab="config"]') : null;
          if (cfgTab) {
            cfgTab.classList.toggle('modal-tab-disabled', !ready);
            cfgTab.disabled = !ready;
          }
          var cfgPanelBody = el('cfg-panel-body');
          if (cfgPanelBody) {
            cfgPanelBody.style.opacity = ready ? '' : '0.4';
            cfgPanelBody.style.pointerEvents = ready ? '' : 'none';
          }
        }
      }

      var healthDot = el('health-dot');
      if (healthDot) healthDot.className = 'health-dot';
      var lastRefresh = el('last-refresh');
      if (lastRefresh) {
        var now = new Date();
        lastRefresh.textContent = now.toLocaleTimeString();
        lastRefresh.title = now.toLocaleString();
      }
    }).catch(function () {
      var healthDot = el('health-dot');
      if (healthDot) healthDot.className = 'health-dot red';
    });
  }

  function loadInvite() {
    P.getInvite().then(function (d) {
      var url = d.self_url || '(not set)';
      var bundle = d.bundle || '';
      var tokenUrl = el('token-url');
      if (tokenUrl) tokenUrl.textContent = url;
      P.setSecret('invite-bundle', bundle);
      var settingsUrl = el('settings-token-url');
      if (settingsUrl) settingsUrl.textContent = url;
      P.setSecret('settings-invite-bundle', bundle);
      var aboutUrl = el('about-url');
      if (aboutUrl) aboutUrl.textContent = url;
      var ns = el('health-namespace');
      if (ns) ns.textContent = d.namespace || '—';
    }).catch(function () {});
  }

  function setSegVal(ctrlId, activeBtn) {
    var ctrl = el(ctrlId);
    if (!ctrl) return;
    var val = activeBtn && activeBtn.dataset && activeBtn.dataset.val;
    var btns = ctrl.querySelectorAll('button[data-val]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i] === activeBtn);
    }
  }
  function saveSetting(key, value) {
    var payload = {};
    payload[key] = value;
    P.updateSettings(payload).then(function () {
      toast('Saved', 'ok');
    }).catch(function (err) { toast(err.message, 'error'); });
  }
  // ── Tunnel peer allowlist state ────────────────────────────────
  // peer-level only: denied = {peerName: true}. Empty = all allowed.
  var _tunnelState = {
    peers: [],      // [{name}] inbound/bidirectional peers from last refresh
    denied: {},     // {peerName: true}
    allowedRaw: '', // last known allowed_tunnel_peers value from settings
    peersKey: ''    // JSON snapshot for change detection
  };

  function _renderTunnelPeerList() {
    var list = el('tunnel-peer-list');
    if (!list) return;
    list.querySelectorAll('.tunnel-peer-row').forEach(function (r) { r.remove(); });
    _tunnelState.peers.forEach(function (peer) {
      var denied = !!_tunnelState.denied[peer.name];
      var row = document.createElement('div');
      row.className = 'tunnel-peer-row';
      row.dataset.peer = peer.name;
      row.innerHTML =
        '<label class="toggle tunnel-peer-toggle">' +
          '<input type="checkbox" class="tunnel-peer-chk" data-peer="' + _esc(peer.name) + '"' + (denied ? '' : ' checked') + '>' +
          '<span class="toggle-slider"></span>' +
        '</label>' +
        '<span class="tunnel-peer-name">' + _esc(peer.name) + '</span>';
      list.appendChild(row);
    });
    list.querySelectorAll('.tunnel-peer-chk').forEach(function (chk) {
      chk.addEventListener('change', function () {
        if (chk.checked) delete _tunnelState.denied[chk.dataset.peer];
        else _tunnelState.denied[chk.dataset.peer] = true;
        P.updateSettings({ allowed_tunnel_peers: _getTunnelAllowedValue() })
          .then(function () { toast('Saved', 'ok'); })
          .catch(function (err) { toast(err.message, 'error'); });
      });
    });
  }

  function _syncTunnelPeersFromData(peers) {
    var inbound = peers.filter(function (p) {
      return p.direction === 'incoming' || p.direction === 'bidirectional';
    });
    var newPeers = inbound.map(function (p) { return { name: p.name }; });
    var newKey = JSON.stringify(newPeers);
    if (newKey === _tunnelState.peersKey) return;
    _tunnelState.peers = newPeers;
    _tunnelState.peersKey = newKey;
    _loadTunnelDeniedFromValue(_tunnelState.allowedRaw);
  }

  function _loadTunnelDeniedFromValue(allowedStr) {
    _tunnelState.allowedRaw = allowedStr || '';
    _tunnelState.denied = {};
    var entries = (allowedStr || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (entries[0] === '__none__') {
      _tunnelState.peers.forEach(function (p) { _tunnelState.denied[p.name] = true; });
    } else if (entries.length) {
      var allowedSet = {};
      entries.forEach(function (e) { allowedSet[e] = true; });
      _tunnelState.peers.forEach(function (p) { if (!allowedSet[p.name]) _tunnelState.denied[p.name] = true; });
    }
    _renderTunnelPeerList();
  }

  function _getTunnelAllowedValue() {
    if (!Object.keys(_tunnelState.denied).length) return '';
    var allowed = _tunnelState.peers.filter(function (p) { return !_tunnelState.denied[p.name]; }).map(function (p) { return p.name; });
    return allowed.length ? allowed.join(', ') : '__none__';
  }

  function _populateHealthGrid(s, selfUrl, versionHash) {
    function setBadge(id, ok, trueLabel, falseLabel) {
      var e = el(id);
      if (!e) return;
      if (ok) e.innerHTML = '<span class="badge badge-mtls"><span class="badge-dot"></span>' + _esc(trueLabel) + '</span>';
      else e.innerHTML = '<span class="badge badge-failed">' + _esc(falseLabel) + '</span>';
    }
    setBadge('health-inbound-apps', s.allow_inbound_remoteapps, 'Enabled', 'Disabled');
    setBadge('health-pvcs', s.allow_pvcs, 'Enabled', 'Disabled');
    setBadge('health-approval', !s.require_remoteapp_approval, 'Auto', 'Manual');
    var ll = el('health-log-level');
    if (ll) ll.textContent = s.log_level || 'INFO';
    var au = el('health-agent-url');
    if (au) au.textContent = selfUrl || '—';
    var vh = el('health-version');
    if (vh) vh.textContent = versionHash || '—';
  }

  function loadSettings() {
    var logLevelCtrl = el('setting-log-level');
    var inboundApps = el('setting-inbound-apps');
    var healthGrid = el('health-grid');
    if (!logLevelCtrl && !inboundApps && !healthGrid) return;
    P.getSettings().then(function (s) {
      var level = (s.log_level || 'INFO').toUpperCase();
      if (logLevelCtrl) {
        var btns = logLevelCtrl.querySelectorAll('button[data-val]');
        for (var i = 0; i < btns.length; i++) {
          btns[i].classList.toggle('active', (btns[i].dataset.val || '') === level);
        }
      }
      function setChk(id, val) { var e = el(id); if (e) e.checked = !!val; }
      function setVal(id, val) { var e = el(id); if (e) e.value = (val === 0 || val) ? val : ''; }
      setChk('setting-inbound-apps',        s.allow_inbound_remoteapps);
      setChk('setting-require-approval',    s.require_remoteapp_approval);
      setChk('setting-require-res-requests',s.require_resource_requests);
      setChk('setting-require-res-limits',  s.require_resource_limits);
      setChk('setting-allow-pvcs',          s.allow_pvcs);
      setVal('setting-max-pvc-per',         s.max_pvc_storage_per_pvc_gb);
      setVal('setting-max-pvc-total',       s.max_pvc_storage_total_gb);
      _proxyDomain = s.proxy_domain || '';
      var domainDisplay = document.getElementById('setting-proxy-domain-display');
      if (domainDisplay) domainDisplay.textContent = _proxyDomain || '(not configured)';
      setChk('setting-inbound-tunnels',     s.allow_inbound_tunnels);
      setChk('setting-registry-pull-enabled', s.registry_pull_enabled);
      setVal('setting-allowed-peers',       s.allowed_source_peers);
      setVal('setting-allowed-images',      s.allowed_images);
      setVal('setting-blocked-images',      s.blocked_images);
      setVal('setting-max-cpu-req',         s.max_cpu_request_per_pod);
      setVal('setting-max-cpu-lim',         s.max_cpu_limit_per_pod);
      setVal('setting-max-mem-req',         s.max_memory_request_per_pod);
      setVal('setting-max-mem-lim',         s.max_memory_limit_per_pod);
      setVal('setting-max-replicas',        s.max_replicas_per_app || '');
      setVal('setting-max-total-deploys',   s.max_total_deployments || '');
      setVal('setting-max-total-pods',      s.max_total_pods || '');
      setVal('setting-max-total-cpu',       s.max_total_cpu_requests);
      setVal('setting-max-total-mem',       s.max_total_memory_requests);
      _loadTunnelDeniedFromValue(s.allowed_tunnel_peers || '');
      // Health grid (overview page)
      if (el('health-grid')) {
        P.getInvite().then(function (tok) {
          _populateHealthGrid(s, tok.self_url || '', tok.version_hash || '');
        }).catch(function () { _populateHealthGrid(s, '', ''); });
      }
    }).catch(function () {});
  }

  // ── Confirm dialog ──────────────────────────────────────────
  function showConfirm(title, body, okLabel, okClass, callback) {
    var backdrop = el('dialog-backdrop');
    var titleEl = el('dialog-title');
    var bodyEl = el('dialog-body');
    var actionsEl = el('dialog-actions');
    if (!backdrop) { return; }
    titleEl.textContent = title;
    bodyEl.textContent = body;
    actionsEl.innerHTML = '';
    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn-sm btn-outline';
    var okBtn = document.createElement('button');
    okBtn.textContent = okLabel || 'Confirm';
    okBtn.className = 'btn-sm ' + (okClass || 'btn-danger');
    function close() { backdrop.classList.remove('open'); }
    cancelBtn.addEventListener('click', close);
    okBtn.addEventListener('click', function () { close(); callback(); });
    backdrop.addEventListener('click', function handler(e) {
      if (e.target === backdrop) { close(); backdrop.removeEventListener('click', handler); }
    });
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);
    backdrop.classList.add('open');
    okBtn.focus();
  }

  function showPeerRemoveConfirm(peerName, callback) {
    var submittedCount = _lastSubmitted.filter(function (a) { return a.target_peer === peerName; }).length;
    var executingCount = _lastExecuting.filter(function (a) { return a.source_peer === peerName; }).length;

    var backdrop = el('dialog-backdrop');
    var titleEl  = el('dialog-title');
    var bodyEl   = el('dialog-body');
    var inputEl  = el('dialog-input');
    var actionsEl = el('dialog-actions');
    if (!backdrop) { return; }

    titleEl.textContent = 'Remove peer "' + peerName + '"?';

    var parts = [];
    if (submittedCount > 0) parts.push(submittedCount + ' submitted workload' + (submittedCount !== 1 ? 's' : ''));
    if (executingCount > 0) parts.push(executingCount + ' executing workload' + (executingCount !== 1 ? 's' : ''));
    var workloadMsg = parts.length
      ? 'This will permanently delete ' + parts.join(' and ') + ' on the peer cluster. This cannot be undone. '
      : 'No workloads are currently associated with this peer. ';
    bodyEl.textContent = workloadMsg + 'Type the peer name to confirm.';

    inputEl.value = '';
    inputEl.placeholder = peerName;
    inputEl.style.display = '';

    actionsEl.innerHTML = '';
    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn-sm btn-outline';
    var okBtn = document.createElement('button');
    okBtn.textContent = 'Remove peer';
    okBtn.className = 'btn-sm btn-danger';
    okBtn.disabled = true;

    function checkInput() { okBtn.disabled = inputEl.value !== peerName; }
    inputEl.addEventListener('input', checkInput);

    function close() {
      backdrop.classList.remove('open');
      inputEl.style.display = 'none';
      inputEl.value = '';
      inputEl.removeEventListener('input', checkInput);
    }
    cancelBtn.addEventListener('click', close);
    okBtn.addEventListener('click', function () { if (inputEl.value === peerName) { close(); callback(); } });
    backdrop.addEventListener('click', function handler(e) {
      if (e.target === backdrop) { close(); backdrop.removeEventListener('click', handler); }
    });
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);
    backdrop.classList.add('open');
    inputEl.focus();
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button, a');
    if (!btn) return;
    if (btn.classList.contains('app-open-link') || btn.classList.contains('app-detail-btn')) {
      e.preventDefault();
      var appId = btn.dataset.appId;
      var row = btn.closest('[data-app-id]');
      if (!appId && row) appId = row.dataset.appId;
      if (appId) openAppModal(appId);
    } else if (btn.classList.contains('app-restart-btn')) {
      e.preventDefault();
      var row = btn.closest('tr[data-app-id]');
      if (!row) return;
      var appId = row.dataset.appId, appName = row.dataset.appName;
      showConfirm('Rollout restart?', 'Restart all pods in "' + (appName || appId) + '" one by one. Running traffic will continue during the rollout.', 'Restart', '', function () {
        P.restartApp(appId).then(function () { toast('Rollout restart triggered', 'ok'); }).catch(function (err) { toast('Error: ' + err.message, 'error'); });
      });
    } else if (btn.classList.contains('app-delete-btn')) {
      e.preventDefault();
      var row = btn.closest('tr[data-app-id]');
      if (!row) return;
      var appId = row.dataset.appId, appName = row.dataset.appName, appType = row.dataset.appType;
      var deleteMsg = appType === 'executing'
        ? 'Stop executing "' + appName + '" on this cluster. The peer that submitted it may re-deploy it.'
        : 'Delete "' + appName + '" and remove it from the peer cluster. This cannot be undone.';
      showConfirm('Delete workload?', deleteMsg, 'Delete', 'btn-danger', function () { deleteApp(appId, appName); });
    } else if (btn.classList.contains('peer-info-btn')) {
      e.preventDefault();
      var row = btn.closest('tr[data-peer-name]');
      if (!row) return;
      openPeerModal(row.dataset.peerName);
    } else if (btn.classList.contains('peer-remove-btn')) {
      e.preventDefault();
      var row = btn.closest('tr[data-peer-url]');
      if (!row) return;
      var peerName = row.dataset.peerName;
      showPeerRemoveConfirm(peerName, function () { removePeer(peerName); });
    } else if (btn.dataset.approveApp) {
      e.preventDefault();
      btn.disabled = true; btn.textContent = 'Approving…';
      P.approveApp(btn.dataset.approveApp).then(function () { toast('Approved ' + (btn.dataset.approveName || ''), 'ok'); refresh(); }).catch(function (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Approve'; refresh(); });
    } else if (btn.dataset.rejectApp) {
      e.preventDefault();
      var approvalName = btn.closest('.approval-item') && btn.closest('.approval-item').querySelector('.approval-item-name');
      var aname = approvalName ? approvalName.textContent : 'this workload';
      showConfirm('Reject workload?', 'Reject "' + aname + '" — it will not be deployed on this cluster.', 'Reject', 'btn-danger', function () {
        P.rejectApp(btn.dataset.rejectApp).then(function () { toast('Rejected', 'ok'); refresh(); }).catch(function () { refresh(); });
      });
    } else if (btn.dataset.copyEl) {
      e.preventDefault();
      P.copyText(btn.dataset.copyEl, btn);
    }
  });

  var deployForm = el('deploy-form');
  if (deployForm) {
    deployForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var nameEl = el('app-name');
      var name = nameEl ? nameEl.value.trim() : '';
      var yamlEl = el('app-spec-yaml');
      var yaml = yamlEl ? yamlEl.value : '';
      if (!name) return;
      if (!yaml.trim()) { toast('Spec cannot be empty', 'error'); return; }
      if (yaml.indexOf('image:') === -1) { toast('Spec must include an "image" field', 'error'); return; }
      var targetPeerEl = el('app-target-peer');
      var targetPeer = targetPeerEl ? targetPeerEl.value : '';
      // If peer selector exists and has choices, require a selection
      if (targetPeerEl && !targetPeer) {
        var peerOpts = Array.from(targetPeerEl.options).filter(function (o) { return !o.disabled && !o.hidden && o.value; });
        if (peerOpts.length > 0) { toast('Select a target peer', 'error'); return; }
      }
      var payload = { name: name, spec_yaml: yaml };
      if (targetPeer) payload.target_peer = targetPeer;
      P.createRemoteApp(payload).then(function () {
        toast('Deployed ' + name, 'ok');
        if (nameEl) nameEl.value = '';
        setDeploySpecValue(window.PorpulsionVscodeEditor && window.PorpulsionVscodeEditor.getDefaultDeploySpec ? window.PorpulsionVscodeEditor.getDefaultDeploySpec() : 'image: nginx:latest\nreplicas: 1\nports:\n  - port: 80\n    name: http');
        setTimeout(refresh, 500);
      }).catch(function (err) {
        if (err.message && err.message.indexOf('inbound') !== -1) toast('Remote agent has inbound workloads disabled — enable in peer Settings', 'warn');
        else toast('Error: ' + err.message, 'error');
      });
    });
  }

  var connectPeerForm = el('connect-peer-form');
  if (connectPeerForm) {
    connectPeerForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var bundleEl = el('new-peer-bundle');
      var bundle = bundleEl ? bundleEl.value.trim() : '';
      if (!bundle) { toast('Paste an invite bundle first', 'error'); return; }
      P.connectPeer({ bundle: bundle }).then(function (d) {
        toast(d.message || 'Connecting…', 'ok');
        if (bundleEl) bundleEl.value = '';
        setTimeout(refresh, 800);
      }).catch(function (err) {
        toast(err.message || 'Failed', 'error');
      });
    });
  }

  var _currentAppId = null;

  function _specToYaml(spec) {
    if (!spec) return '';
    var lines = [];
    var keys = ['image', 'targetPeer', 'replicas', 'command', 'args', 'imagePullPolicy'];
    keys.forEach(function (k) {
      if (spec[k] != null) {
        var v = spec[k];
        if (Array.isArray(v)) lines.push(k + ': [' + v.map(function (x) { return JSON.stringify(x); }).join(', ') + ']');
        else lines.push(k + ': ' + v);
      }
    });
    if (spec.ports && spec.ports.length) {
      lines.push('ports:');
      spec.ports.forEach(function (p) {
        lines.push('  - port: ' + (p.port || 80) + (p.name ? '\n    name: ' + p.name : ''));
      });
    }
    if (spec.resources) {
      lines.push('resources:');
      ['requests', 'limits'].forEach(function (t) {
        if (spec.resources[t]) {
          lines.push('  ' + t + ':');
          Object.keys(spec.resources[t]).forEach(function (k) { lines.push('    ' + k + ': ' + spec.resources[t][k]); });
        }
      });
    }
    if (spec.env && spec.env.length) {
      lines.push('env:');
      spec.env.forEach(function (e) {
        if (e.valueFrom) {
          lines.push('  - name: ' + e.name);
          if (e.valueFrom.secretKeyRef) {
            lines.push('    valueFrom:');
            lines.push('      secretKeyRef:');
            lines.push('        name: ' + (e.valueFrom.secretKeyRef.name || ''));
            lines.push('        key: ' + (e.valueFrom.secretKeyRef.key || ''));
          } else if (e.valueFrom.configMapKeyRef) {
            lines.push('    valueFrom:');
            lines.push('      configMapKeyRef:');
            lines.push('        name: ' + (e.valueFrom.configMapKeyRef.name || ''));
            lines.push('        key: ' + (e.valueFrom.configMapKeyRef.key || ''));
          } else if (e.valueFrom.fieldRef) {
            lines.push('    valueFrom:');
            lines.push('      fieldRef:');
            lines.push('        fieldPath: ' + (e.valueFrom.fieldRef.fieldPath || ''));
          } else {
            lines.push('    value: ' + (e.value || ''));
          }
        } else {
          lines.push('  - name: ' + e.name + '\n    value: ' + (e.value != null ? e.value : ''));
        }
      });
    }
    if (spec.additionalConfig && spec.additionalConfig.length) {
      lines.push('additionalConfig:');
      spec.additionalConfig.forEach(function (c) {
        lines.push('  - mountPath: ' + (c.mountPath || ''));
        var content = (c.content || '').toString();
        if (content.indexOf('\n') >= 0) lines.push('    content: |\n      ' + content.replace(/\n/g, '\n      '));
        else lines.push('    content: ' + content);
      });
    }
    if (spec.configMaps && spec.configMaps.length) {
      lines.push('configMaps:');
      spec.configMaps.forEach(function (cm) {
        lines.push('  - name: ' + cm.name + '\n    mountPath: ' + (cm.mountPath || ''));
        if (cm.data && Object.keys(cm.data).length) {
          lines.push('    data:');
          Object.keys(cm.data).forEach(function (k) {
            var v = (cm.data[k] || '').toString();
            if (v.indexOf('\n') >= 0) lines.push('      ' + k + ': |\n        ' + v.replace(/\n/g, '\n        '));
            else lines.push('      ' + k + ': ' + v);
          });
        }
      });
    }
    if (spec.secrets && spec.secrets.length) {
      lines.push('secrets:');
      spec.secrets.forEach(function (sec) {
        lines.push('  - name: ' + sec.name + '\n    mountPath: ' + (sec.mountPath || ''));
        if (sec.data && Object.keys(sec.data).length) {
          lines.push('    data:');
          Object.keys(sec.data).forEach(function (k) {
            var v = (sec.data[k] || '').toString();
            if (v.indexOf('\n') >= 0) lines.push('      ' + k + ': |\n        ' + v.replace(/\n/g, '\n        '));
            else lines.push('      ' + k + ': ' + v);
          });
        }
      });
    }
    if (spec.pvcs && spec.pvcs.length) {
      lines.push('pvcs:');
      spec.pvcs.forEach(function (pvc) {
        lines.push('  - name: ' + pvc.name + '\n    mountPath: ' + (pvc.mountPath || '') + '\n    storage: ' + (pvc.storage || '1Gi') + '\n    accessMode: ' + (pvc.accessMode || 'ReadWriteOnce'));
      });
    }
    return lines.join('\n');
  }

  function _showModalTab(tabName) {
    var body = el('app-modal-body');
    var tabsBar = el('app-modal-tabs-bar');
    if (!body) return;
    // Update tab button active state (tabs live in tabsBar now)
    var tabContainer = tabsBar || body;
    tabContainer.querySelectorAll('.modal-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tabName); });
    body.querySelectorAll('.modal-tab-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === tabName); });
    // Terminal AND logs tabs need full-height flex layout (they contain a terminal widget)
    var isFullHeight = tabName === 'terminal' || tabName === 'logs';
    body.classList.toggle('modal-body-terminal', isFullHeight);
    // Show footer Save button for config and spec tabs only
    var footer = el('app-modal-footer');
    if (footer) {
      var showEditSave = tabName === 'edit' && !!el('modal-spec-textarea');
      if (tabName === 'config' || showEditSave) {
        var btnId = tabName === 'config' ? 'cfg-tab-save' : 'spec-tab-save';
        footer.style.display = '';
        footer.innerHTML = '<button type="button" class="btn-sm" id="' + btnId + '">Save</button>';
      } else {
        footer.style.display = 'none';
        footer.innerHTML = '';
      }
    }
    if (tabName !== 'terminal' && _execWs) { try { _execWs.close(); } catch(e) {} _execWs = null; }
    if (tabName === 'logs') _fetchModalLogs();
    if (tabName === 'terminal') _initExecTab();
    if (tabName === 'edit' && window.PorpulsionVscodeEditor) {
      var specYamlEl = el('modal-spec-textarea');
      var initialVal = specYamlEl ? specYamlEl.dataset.specYaml || '' : '';
      window.PorpulsionVscodeEditor.initModalSpecEditor(
        'modal-spec-editor-host',
        'modal-spec-textarea',
        initialVal,
        function (val) { if (specYamlEl) specYamlEl.value = val; }
      );
    }
  }

  // ── Logs terminal (xterm instance separate from exec terminal) ──
  var _logsTerm = null;
  var _logsFitAddon = null;
  var _logsResizeObserver = null;

  function _logsEnsureTerminal() {
    var wrap = el('logs-terminal-wrap');
    if (!wrap) return false;
    if (_logsTerm) return true;
    if (!window.Terminal) return false;
    _logsTerm = new window.Terminal({
      cursorBlink: false,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', 'Courier New', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        black:   '#484f58', red:     '#ff7b72', green:   '#3fb950',
        yellow:  '#d29922', blue:    '#58a6ff', magenta: '#bc8cff',
        cyan:    '#39c5cf', white:   '#b1bac4',
        brightBlack:   '#6e7681', brightRed:   '#ffa198', brightGreen: '#56d364',
        brightYellow:  '#e3b341', brightBlue:  '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan:    '#56d4dd', brightWhite: '#f0f6fc'
      },
      scrollback: 5000,
      disableStdin: true,
      convertEol: true,
    });
    if (window.FitAddon) {
      _logsFitAddon = new window.FitAddon.FitAddon();
      _logsTerm.loadAddon(_logsFitAddon);
    }
    _logsTerm.open(wrap);
    if (_logsFitAddon) { try { _logsFitAddon.fit(); } catch(e) {} }
    if (window.ResizeObserver) {
      _logsResizeObserver = new ResizeObserver(function () {
        // Only refit when wrap is on — if wrap is off the terminal is intentionally
        // wider than the container and fitAddon.fit() would undo that.
        var wrapBtn = el('logs-wrap-btn');
        var wrapIsOn = wrapBtn ? wrapBtn.classList.contains('active') : true;
        if (wrapIsOn && _logsFitAddon) { try { _logsFitAddon.fit(); } catch(e) {} }
      });
      _logsResizeObserver.observe(wrap);
    }
    return true;
  }

  function _logsDestroyTerminal() {
    if (_logsResizeObserver) { try { _logsResizeObserver.disconnect(); } catch(e) {} _logsResizeObserver = null; }
    if (_logsTerm) { try { _logsTerm.dispose(); } catch(e) {} _logsTerm = null; }
    _logsFitAddon = null;
  }

  // ANSI colour codes for log levels
  var _LOG_LEVEL_COLORS = {
    'ERROR': '\x1b[31m', 'WARN': '\x1b[33m', 'WARNING': '\x1b[33m',
    'INFO': '\x1b[37m',  'DEBUG': '\x1b[34m',
  };
  var _ANSI_RESET = '\x1b[0m';
  var _ANSI_MUTED = '\x1b[2;37m';
  var _ANSI_POD   = '\x1b[36m';

  function _fetchModalLogs() {
    if (!_logsEnsureTerminal()) return;
    if (!_currentAppId) return;
    var podSel = el('logs-pod-select');
    var tailSel = el('logs-tail-select');
    var sbText = el('logs-statusbar-text');
    var tail = tailSel ? parseInt(tailSel.value, 10) : 100;
    var filterPod = podSel ? podSel.value : '';

    _logsTerm.clear();
    if (sbText) sbText.textContent = 'Loading…';

    // Populate pod list first time
    if (podSel && podSel.options.length <= 1) {
      P.getAppPods(_currentAppId).then(function (d) {
        var pods = (d && d.pods) ? d.pods : [];
        pods.forEach(function (pod) {
          var opt = document.createElement('option');
          opt.value = pod.name;
          opt.textContent = pod.name;
          podSel.appendChild(opt);
        });
      }).catch(function () {});
    }

    P.getAppLogs(_currentAppId, tail, 'time').then(function (d) {
      var lines = (d && d.lines) ? d.lines : [];
      if (filterPod) {
        lines = lines.filter(function (l) { return l.pod === filterPod; });
      }
      if (!lines.length) {
        _logsTerm.write(_ANSI_MUTED + '(no logs)' + _ANSI_RESET + '\r\n');
        if (sbText) sbText.textContent = 'No logs';
        return;
      }
      lines.forEach(function (l) {
        var level = (l.level || '').toUpperCase();
        var levelColor = _LOG_LEVEL_COLORS[level] || '';
        var ts = l.ts ? _ANSI_MUTED + l.ts.replace('T', ' ').replace(/\.\d+Z?$/, '') + ' ' + _ANSI_RESET : '';
        var pod = l.pod ? _ANSI_POD + '[' + l.pod + '] ' + _ANSI_RESET : '';
        var msg = levelColor + (l.message || '') + (levelColor ? _ANSI_RESET : '');
        _logsTerm.write(ts + pod + msg + '\r\n');
      });
      if (sbText) sbText.textContent = lines.length + ' lines · pod: ' + (filterPod || 'all');
      if (_logsFitAddon) { try { _logsFitAddon.fit(); } catch(e) {} }
    }).catch(function (err) {
      _logsTerm.write('\x1b[31mError: ' + (err.message || 'failed') + '\x1b[0m\r\n');
      if (sbText) sbText.textContent = 'Error loading logs';
    });
  }

  var _execWs = null;
  var _execTerm = null;
  var _execFitAddon = null;
  var _execResizeObserver = null;
  var _execInitializing = false;

  function _execSetStatus(state) {
    // state: 'connecting' | 'connected' | 'disconnected' | 'error'
    var statusEl = el('exec-status');
    var sbText = el('exec-statusbar-text');
    var labels = { connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected', error: 'Error' };
    var colors = { connecting: '#f0a732', connected: '#3fb950', disconnected: '#6e7681', error: '#ff7b72' };
    if (statusEl) {
      var dot = statusEl.querySelector('.exec-status-dot');
      var txt = statusEl.querySelector('.exec-status-text');
      if (dot) {
        dot.style.background = colors[state] || '#6e7681';
        dot.style.animation = state === 'connecting' ? 'exec-pulse 1s ease-in-out infinite' : '';
      }
      if (txt) txt.textContent = labels[state] || state;
    }
    if (sbText) {
      if (state === 'connected') {
        var podSel = el('exec-pod-select');
        var shellSel = el('exec-shell-select');
        sbText.textContent = (podSel ? podSel.value : '') + '  \u00b7  ' + (shellSel ? shellSel.value : '');
      } else {
        sbText.textContent = labels[state] || state;
      }
    }
  }

  function _execEnsureTerminal() {
    var wrap = el('exec-terminal-wrap');
    if (!wrap) return false;
    if (_execTerm) return true;
    if (!window.Terminal) return false;
    _execTerm = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', 'Courier New', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(88, 166, 255, 0.3)',
        black:   '#484f58', red:     '#ff7b72', green:   '#3fb950',
        yellow:  '#d29922', blue:    '#58a6ff', magenta: '#bc8cff',
        cyan:    '#39c5cf', white:   '#b1bac4',
        brightBlack:   '#6e7681', brightRed:   '#ffa198', brightGreen: '#56d364',
        brightYellow:  '#e3b341', brightBlue:  '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan:    '#56d4dd', brightWhite: '#f0f6fc'
      },
      allowProposedApi: false,
      scrollback: 3000,
      convertEol: false,
    });
    if (window.FitAddon) {
      _execFitAddon = new window.FitAddon.FitAddon();
      _execTerm.loadAddon(_execFitAddon);
    }
    _execTerm.open(wrap);
    if (_execFitAddon) {
      try { _execFitAddon.fit(); } catch(e) {}
    }
    _execTerm.onData(function (data) {
      if (_execWs && _execWs.readyState === WebSocket.OPEN) {
        _execWs.send(data);
      }
    });
    // Re-focus terminal on click so arrow keys and special keys work
    wrap.addEventListener('click', function () {
      if (_execTerm) _execTerm.focus();
    });
    // Resize observer — refit terminal and notify server when container size changes
    if (window.ResizeObserver) {
      _execResizeObserver = new ResizeObserver(function () {
        if (_execFitAddon) {
          try { _execFitAddon.fit(); } catch(e) {}
        }
        _execSendResize();
      });
      _execResizeObserver.observe(wrap);
    }
    return true;
  }

  function _execDestroyTerminal() {
    if (_execResizeObserver) { try { _execResizeObserver.disconnect(); } catch(e) {} _execResizeObserver = null; }
    if (_execTerm) { try { _execTerm.dispose(); } catch(e) {} _execTerm = null; }
    _execFitAddon = null;
  }

  function _execSendResize() {
    if (!_execWs || _execWs.readyState !== WebSocket.OPEN || !_execTerm) return;
    _execWs.send(JSON.stringify({ type: 'resize', cols: _execTerm.cols, rows: _execTerm.rows }));
  }

  function _execConnect(pod) {
    // Close any existing connection — mark as superseded so its onclose is silent
    if (_execWs) {
      var old = _execWs;
      old._superseded = true;
      _execWs = null;
      try { old.close(); } catch(e) {}
    }
    if (!_execEnsureTerminal()) return;
    _execTerm.clear();
    _execSetStatus('connecting');

    var shellSel = el('exec-shell-select');
    var shell = shellSel ? shellSel.value : '/bin/bash';
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + location.host + '/api/remoteapp/' + encodeURIComponent(_currentAppId) + '/exec-ws?pod=' + encodeURIComponent(pod) + '&shell=' + encodeURIComponent(shell);
    var ws = new WebSocket(url);
    _execWs = ws;

    ws.onopen = function () {
      if (ws._superseded) return;
      _execSetStatus('connected');
      if (_execFitAddon) { try { _execFitAddon.fit(); } catch(e) {} }
      _execSendResize();
      if (_execTerm) _execTerm.focus();
    };
    ws.onmessage = function (e) {
      if (ws._superseded) return;
      if (_execTerm) _execTerm.write(e.data);
    };
    ws.onerror = function () {
      if (ws._superseded) return;
      _execSetStatus('error');
      if (_execTerm) _execTerm.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');
    };
    ws.onclose = function () {
      if (ws._superseded) return; // intentionally replaced — stay silent
      if (_execWs === ws) _execWs = null;
      _execSetStatus('disconnected');
      if (_execTerm) _execTerm.write('\r\n\x1b[33m[session closed]\x1b[0m\r\n');
    };
  }

  function _initExecTab() {
    // Destroy and recreate terminal on each tab visit (clean slate)
    if (_execWs) { try { _execWs.close(); } catch(e) {} _execWs = null; }
    _execDestroyTerminal();
    _execSetStatus('disconnected');
    var sel = el('exec-pod-select');
    if (!sel || !_currentAppId) return;
    _execInitializing = true;
    sel.innerHTML = '<option value="">Loading…</option>';
    _execInitializing = false;
    _execSetStatus('connecting');
    var sbText = el('exec-statusbar-text');
    if (sbText) sbText.textContent = 'Loading pods…';
    var initAppId = _currentAppId;
    P.getAppPods(_currentAppId).then(function (d) {
      // Modal was closed while we were fetching — discard
      if (_currentAppId !== initAppId) return;
      var pods = (d && d.pods) ? d.pods : [];
      if (!pods.length) {
        _execInitializing = true;
        sel.innerHTML = '<option value="">No running pods</option>';
        _execInitializing = false;
        _execSetStatus('disconnected');
        if (sbText) sbText.textContent = 'No running pods found';
        _execEnsureTerminal();
        if (_execTerm) _execTerm.write('\r\n\x1b[33mNo running pods found.\x1b[0m\r\n');
        return;
      }
      _execInitializing = true;
      sel.innerHTML = pods.map(function (p) {
        var label = p.name + (p.ready ? '' : ' (not ready)');
        return '<option value="' + _esc(p.name) + '">' + _esc(label) + '</option>';
      }).join('');
      _execInitializing = false;
      _execConnect(sel.value);
    }).catch(function () {
      if (_currentAppId !== initAppId) return;
      sel.innerHTML = '<option value="">Failed to load pods</option>';
      _execSetStatus('error');
      if (sbText) sbText.textContent = 'Failed to list pods';
      _execEnsureTerminal();
      if (_execTerm) _execTerm.write('\r\n\x1b[31mFailed to list pods.\x1b[0m\r\n');
    });
  }


  // ── Config tab helpers ──────────────────────────────────────
  // Registry of all active KV editors in the current modal, keyed by "kind/volName"
  var _kvEditors = {};

  var EYE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function _makeEyeBtn(targetInput) {
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-icon'; btn.title = 'Show/hide value';
    btn.style.flexShrink = '0';
    btn.innerHTML = EYE_ICON;
    btn.addEventListener('click', function () {
      var showing = targetInput.type === 'text';
      targetInput.type = showing ? 'password' : 'text';
      btn.innerHTML = showing ? EYE_ICON : EYE_OFF_ICON;
    });
    return btn;
  }

  function _buildKvEditor(containerId, appId, kind, volName, readOnly) {
    var wrap = el(containerId);
    if (!wrap) return;
    var isSecret = kind === 'secret';

    function renderRows(data) {
      wrap.innerHTML = '';
      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;gap:0.5rem;margin-bottom:0.3rem;';
      hdr.innerHTML = '<span style="flex:1;font-size:0.7rem;color:var(--muted2);text-transform:uppercase;letter-spacing:.06em;">Key</span>' +
        '<span style="flex:2;font-size:0.7rem;color:var(--muted2);text-transform:uppercase;letter-spacing:.06em;">Value</span>' +
        (readOnly ? '' : '<span style="width:' + (isSecret ? '60px' : '28px') + ';"></span>');
      wrap.appendChild(hdr);

      var entries = Object.keys(data || {}).map(function (k) { return {k: k, v: data[k]}; });
      if (!entries.length && readOnly) {
        wrap.innerHTML += '<div class="text-muted text-sm" style="padding:0.4rem 0;">(empty)</div>';
        return;
      }

      entries.forEach(function (pair, idx) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:0.5rem;align-items:flex-start;margin-bottom:0.3rem;';
        var keyIn = document.createElement('input');
        keyIn.type = 'text'; keyIn.value = pair.k; keyIn.readOnly = readOnly;
        keyIn.style.flex = '1'; keyIn.style.fontSize = '0.78rem';
        keyIn.dataset.idx = idx; keyIn.dataset.role = 'cfg-key';
        var valIn = _makeValInput('cfg-val', isSecret, pair.v);
        valIn.readOnly = readOnly;
        valIn.dataset.idx = idx;
        row.appendChild(keyIn); row.appendChild(valIn);
        var eyeBtn = isSecret ? _makeEyeBtn(valIn) : null;
        if (eyeBtn) { eyeBtn.classList.add('kv-inline-btn-top'); row.appendChild(eyeBtn); }
        if (!readOnly) {
          var del = document.createElement('button');
          del.type = 'button'; del.className = 'btn-icon btn-icon-danger kv-inline-btn-top';
          del.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
          del.addEventListener('click', function () {
            // Capture current edits from DOM before re-rendering
            wrap.querySelectorAll('[data-role="cfg-key"]').forEach(function (ki) {
              var vi = wrap.querySelector('[data-role="cfg-val"][data-idx="' + ki.dataset.idx + '"]');
              var ek = ki.value.trim();
              if (ek) data[ek] = vi ? vi.value : '';
            });
            delete data[pair.k];
            renderRows(data);
          });
          row.appendChild(del);
        }
        wrap.appendChild(row);
      });

      if (!readOnly) {
        var addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;gap:0.5rem;align-items:flex-start;margin-top:0.25rem;';
        var newKey = document.createElement('input');
        newKey.type = 'text'; newKey.placeholder = 'new-key'; newKey.style.flex = '1'; newKey.style.fontSize = '0.78rem';
        newKey.dataset.role = 'cfg-pending-key';
        var newVal = _makeValInput('cfg-pending-val', isSecret);
        if (isSecret) {
          var pendingEye = _makeEyeBtn(newVal);
          pendingEye.classList.add('kv-inline-btn-top');
          addRow.appendChild(newKey); addRow.appendChild(newVal); addRow.appendChild(pendingEye);
        } else {
          addRow.appendChild(newKey); addRow.appendChild(newVal);
        }
        var addBtn = document.createElement('button');
        addBtn.type = 'button'; addBtn.className = 'btn-sm btn-outline kv-inline-btn-top'; addBtn.style.flexShrink = '0';
        addBtn.textContent = '+ Add';
        addBtn.addEventListener('click', function () {
          var k = newKey.value.trim();
          if (!k) { toast('Key is required', 'error'); return; }
          // Flush current DOM edits into data before re-rendering
          wrap.querySelectorAll('[data-role="cfg-key"]').forEach(function (ki) {
            var vi = wrap.querySelector('[data-role="cfg-val"][data-idx="' + ki.dataset.idx + '"]');
            var ek = ki.value.trim();
            if (ek) data[ek] = vi ? vi.value : '';
          });
          data[k] = newVal.value;
          renderRows(data);
        });
        addRow.appendChild(addBtn);
        wrap.appendChild(addRow);
      }

      // Auto-size all value textareas that already have content (deferred to allow layout)
      setTimeout(function () {
        wrap.querySelectorAll('textarea.kv-val-ta').forEach(function (ta) {
          _autoGrowTextarea(ta);
        });
      }, 0);
    }

    // Register a collector function so the tab-level save button can harvest all editors.
    // dirty is set to true only when the user actually changes something in this editor.
    var editorEntry = { appId: appId, kind: kind, volName: volName, dirty: false,
      collect: function () {
        var out = {};
        wrap.querySelectorAll('[data-role="cfg-key"]').forEach(function (ki) {
          var vi = wrap.querySelector('[data-role="cfg-val"][data-idx="' + ki.dataset.idx + '"]');
          var k = ki.value.trim();
          if (k) out[k] = vi ? vi.value : '';
        });
        // Capture the pending new-key row (typed but not yet added via + Add)
        var pendingKey = wrap.querySelector('[data-role="cfg-pending-key"]');
        var pendingVal = wrap.querySelector('[data-role="cfg-pending-val"]');
        if (pendingKey && pendingKey.value.trim()) {
          out[pendingKey.value.trim()] = pendingVal ? pendingVal.value : '';
        }
        return out;
      },
    };
    _kvEditors[kind + '/' + volName] = editorEntry;

    // Mark dirty on any user input inside this editor's container
    wrap.addEventListener('input', function () { editorEntry.dirty = true; });

    // Load current data from server
    var url = P.API_BASE + '/remoteapp/' + appId + '/config/' + kind + '/' + encodeURIComponent(volName);
    wrap.innerHTML = '<div class="text-muted text-sm">Loading…</div>';
    fetch(url).then(function (r) { return r.json(); }).then(function (res) {
      renderRows(res.data || {});
    }).catch(function () {
      wrap.innerHTML = '<div class="text-muted text-sm" style="color:var(--red)">Failed to load</div>';
    });
  }

  function _buildConfigTab(spec, isSubmitted) {
    var hasConfigMaps = spec.configMaps && spec.configMaps.length;
    var hasSecrets = spec.secrets && spec.secrets.length;
    var hasPvcs = spec.pvcs && spec.pvcs.length;
    var html = '';

    var DEL_BTN = '<button type="button" class="btn-icon btn-icon-danger cfg-obj-delete" title="Remove">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>' +
      '</button>';

    if (hasConfigMaps) {
      html += '<div style="margin-bottom:1rem;"><h4 style="font-size:0.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted2);margin-bottom:0.5rem;">ConfigMaps</h4>';
      spec.configMaps.forEach(function (cm, i) {
        var cid = 'cfg-cm-' + i;
        html += '<div style="margin-bottom:0.85rem;">' +
          '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem;">' +
            '<span style="font-size:0.82rem;font-weight:600;">' + _esc(cm.name) + '</span>' +
            '<span class="mono" style="color:var(--muted2);font-size:0.72rem;flex:1;">-> ' + _esc(cm.mountPath || '') + '</span>' +
            (isSubmitted ? DEL_BTN.replace('cfg-obj-delete', 'cfg-obj-delete cfg-cm-del-' + i) : '') +
          '</div>' +
          '<div id="' + cid + '"></div></div>';
      });
      html += '</div>';
    }

    if (hasSecrets) {
      html += '<div style="margin-bottom:1rem;"><h4 style="font-size:0.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted2);margin-bottom:0.5rem;">Secrets</h4>';
      spec.secrets.forEach(function (sec, i) {
        var sid = 'cfg-sec-' + i;
        html += '<div style="margin-bottom:0.85rem;">' +
          '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem;">' +
            '<span style="font-size:0.82rem;font-weight:600;">' + _esc(sec.name) + '</span>' +
            '<span class="mono" style="color:var(--muted2);font-size:0.72rem;flex:1;">-> ' + _esc(sec.mountPath || '') + '</span>' +
            (isSubmitted ? DEL_BTN.replace('cfg-obj-delete', 'cfg-obj-delete cfg-sec-del-' + i) : '') +
          '</div>' +
          '<div id="' + sid + '"></div></div>';
      });
      html += '</div>';
    }

    if (hasPvcs) {
      html += '<div style="margin-bottom:1rem;"><h4 style="font-size:0.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted2);margin-bottom:0.5rem;">Persistent Volumes</h4>';
      spec.pvcs.forEach(function (pvc, i) {
        html += '<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem;">' +
          '<span style="font-size:0.82rem;font-weight:600;">' + _esc(pvc.name) + '</span>' +
          '<span class="mono text-sm" style="flex:1;">' + _esc(pvc.mountPath) + ' · ' + _esc(pvc.storage) + ' · ' + _esc(pvc.accessMode) + '</span>' +
          (isSubmitted ? DEL_BTN.replace('cfg-obj-delete', 'cfg-obj-delete cfg-pvc-del-' + i) : '') +
          '</div>';
      });
      html += '</div>';
    }

    if (!hasConfigMaps && !hasSecrets && !hasPvcs) {
      html += '<p class="text-muted text-sm" style="padding:0.25rem 0 0.75rem;">No ConfigMaps, Secrets, or PVCs attached yet.</p>';
    }

    // Save button is rendered in the modal footer (detail-actions), not inline here

    if (isSubmitted) {
      html +=
        '<hr style="border:none;border-top:1px solid var(--glass-border);margin:0.75rem 0;">' +
        '<div class="cfg-add-forms">' +
          _buildAddConfigForm('configmap') +
          _buildAddConfigForm('secret') +
          _buildAddPvcForm() +
        '</div>';
    }

    return html;
  }

  function _buildAddConfigForm(kind) {
    var label = kind === 'secret' ? 'Secret' : 'ConfigMap';
    var placeholder = kind === 'secret' ? 'e.g. db-creds' : 'e.g. app-config';
    var prefix = 'add-' + kind;
    return '<div class="cfg-add-section" id="' + prefix + '-section">' +
      '<div class="cfg-add-header" data-toggle="' + prefix + '">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:0.3rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
        'Add ' + label +
      '</div>' +
      '<div class="cfg-add-body" id="' + prefix + '-body" hidden>' +
        '<div class="form-row-2" style="margin-bottom:0.5rem;">' +
          '<div><label class="form-label">Name</label><input type="text" id="' + prefix + '-name" placeholder="' + placeholder + '" autocomplete="off"></div>' +
          '<div><label class="form-label">Mount path</label><input type="text" id="' + prefix + '-mount" placeholder="e.g. /etc/config" autocomplete="off"></div>' +
        '</div>' +
        '<div id="' + prefix + '-kv"></div>' +
      '</div>' +
    '</div>';
  }

  function _buildAddPvcForm() {
    return '<div class="cfg-add-section" id="add-pvc-section">' +
      '<div class="cfg-add-header" data-toggle="add-pvc">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:0.3rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
        'Add Persistent Volume' +
      '</div>' +
      '<div class="cfg-add-body" id="add-pvc-body" hidden>' +
        '<div class="form-row-2" style="margin-bottom:0.5rem;">' +
          '<div><label class="form-label">Name</label><input type="text" id="add-pvc-name" placeholder="e.g. data" autocomplete="off"></div>' +
          '<div><label class="form-label">Mount path</label><input type="text" id="add-pvc-mount" placeholder="e.g. /data" autocomplete="off"></div>' +
        '</div>' +
        '<div class="form-row-2" style="margin-bottom:0.5rem;">' +
          '<div><label class="form-label">Storage</label><input type="text" id="add-pvc-storage" placeholder="e.g. 1Gi" autocomplete="off" value="1Gi"></div>' +
          '<div><label class="form-label">Access mode</label>' +
            '<select id="add-pvc-mode" style="width:100%;">' +
              '<option value="ReadWriteOnce">ReadWriteOnce</option>' +
              '<option value="ReadWriteMany">ReadWriteMany</option>' +
              '<option value="ReadOnlyMany">ReadOnlyMany</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // Auto-grow helper: adjusts textarea height to fit its content.
  function _autoGrowTextarea(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 32) + 'px';
  }

  // Creates a value input. For secrets: a password input. For configmap/plain: a
  // single-row textarea that auto-grows as the user types multi-line content.
  // Keeps the same data-role so existing collectors work unchanged.
  function _makeValInput(role, isSecret, initialValue) {
    var inputEl;
    if (isSecret) {
      inputEl = document.createElement('input');
      inputEl.type = 'password';
      inputEl.placeholder = 'value';
      inputEl.style.flex = '2';
      inputEl.style.fontSize = '0.78rem';
      inputEl.dataset.role = role;
      if (initialValue != null) inputEl.value = initialValue;
    } else {
      inputEl = document.createElement('textarea');
      inputEl.placeholder = 'value';
      inputEl.className = 'kv-val-ta';
      inputEl.dataset.role = role;
      if (initialValue != null) inputEl.value = initialValue;
      // Auto-grow on input
      inputEl.addEventListener('input', function () { _autoGrowTextarea(inputEl); });
      // Initial size (deferred so it works even before DOM insertion)
      setTimeout(function () { _autoGrowTextarea(inputEl); }, 0);
    }
    return inputEl;
  }

  function _initAddKvEditor(wrap, isSecret) {
    function addRow() {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:0.5rem;align-items:flex-start;margin-bottom:0.3rem;';
      var keyIn = document.createElement('input');
      keyIn.type = 'text'; keyIn.placeholder = 'key'; keyIn.style.flex = '1'; keyIn.style.fontSize = '0.78rem';
      keyIn.dataset.role = 'add-kv-key';
      var valIn = _makeValInput('add-kv-val', isSecret);
      row.appendChild(keyIn); row.appendChild(valIn);
      if (isSecret) {
        var eyeB = _makeEyeBtn(valIn);
        eyeB.classList.add('kv-inline-btn-top');
        row.appendChild(eyeB);
      }
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'btn-icon btn-icon-danger kv-inline-btn-top';
      del.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      del.addEventListener('click', function () { wrap.removeChild(row); });
      row.appendChild(del);
      wrap.insertBefore(row, wrap.lastElementChild);
    }
    var addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn-sm btn-outline';
    addBtn.style.marginTop = '0.25rem';
    addBtn.textContent = '+ Add key';
    addBtn.addEventListener('click', function () { addRow(); });
    wrap.appendChild(addBtn);
    addRow();
  }

  function _readAddKvEditor(containerId) {
    var wrap = el(containerId);
    if (!wrap) return [];
    var pairs = [];
    wrap.querySelectorAll('[data-role="add-kv-key"]').forEach(function (ki) {
      var vi = ki.parentElement ? ki.parentElement.querySelector('[data-role="add-kv-val"]') : null;
      var k = ki.value.trim();
      if (k) pairs.push({ key: k, value: vi ? vi.value : '' });
    });
    return pairs;
  }

  function openAppModal(appId, initialTab) {
    _currentAppId = appId;
    _kvEditors = {};  // clear registry for new modal session
    var modal = el('app-modal');
    var title = el('app-modal-title');
    var body = el('app-modal-body');
    if (!modal || !body) return;
    if (title) title.textContent = 'App Detail';
    body.innerHTML = '<p class="text-muted text-sm">Loading…</p>';
    modal.classList.add('open');
    document.documentElement.style.overflowX = 'hidden';
    P.getAppDetail(appId).then(function (d) {
      var app = d.app || {};
      // Use CR spec when available (fullest representation including targetPeer etc.)
      var crSpec = d.cr && d.cr.spec;
      var spec = crSpec || (d.k8s && d.k8s.spec) || app.spec || {};
      var isSubmitted = !!app.target_peer;

      // Update modal title with app name
      if (title) {
        title.innerHTML = _esc(app.name || app.id) +
          '<span class="modal-title-badge">' + (isSubmitted ? 'remote' : 'executing') + '</span>';
      }

      // ── Overview tab ──────────────────────────────────────────
      var peerLabel = isSubmitted ? 'Running on' : 'From peer';
      var peerVal = _esc(app.target_peer || app.source_peer || '—');
      // Status hero bar
      var overviewHtml =
        '<div class="app-overview-hero">' +
          '<div class="app-overview-hero-left">' +
            '<div class="app-overview-image mono">' + _esc(spec.image || '—') + '</div>' +
            '<div class="app-overview-meta">' +
              statusBadge(app.status) +
              '<span class="app-overview-peer">' +
                '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="7" r="3"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/></svg>' +
                peerLabel + ': <strong>' + peerVal + '</strong>' +
              '</span>' +
              (spec.replicas ? '<span class="app-overview-replicas">' + spec.replicas + ' replica' + (spec.replicas !== 1 ? 's' : '') + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="app-overview-hero-right">' +
            '<div class="app-overview-id-row"><span class="app-overview-id-label">ID</span><code class="app-overview-id mono">' + _esc(app.id) + '</code></div>' +
            '<div class="app-overview-updated text-muted">' + timeAgo(app.updated_at) + '</div>' +
          '</div>' +
        '</div>';

      // Detail grid — rich info, no raw Spec block
      var detailRows = '';
      if (spec.ports && spec.ports.length) {
        detailRows += '<div class="ov-row"><span class="ov-label">Ports</span><span class="ov-val">' + spec.ports.map(function (p) { return '<span class="ov-tag">' + (p.name ? _esc(p.name) + ':' : '') + p.port + '</span>'; }).join('') + '</span></div>';
      }
      if (spec.command || spec.args) {
        var cmdStr = [].concat(spec.command || []).concat(spec.args || []).join(' ');
        detailRows += '<div class="ov-row"><span class="ov-label">Command</span><code class="ov-val mono ov-code">' + _esc(cmdStr) + '</code></div>';
      }
      if (spec.env && spec.env.length) {
        detailRows += '<div class="ov-row"><span class="ov-label">Env vars</span><span class="ov-val">' + spec.env.length + ' variable' + (spec.env.length !== 1 ? 's' : '') + '</span></div>';
      }
      if (spec.resources && (spec.resources.requests || spec.resources.limits)) {
        var req = spec.resources.requests || {};
        var lim = spec.resources.limits || {};
        var resStr = [];
        if (req.cpu || lim.cpu) resStr.push('CPU: ' + (req.cpu || '—') + ' / ' + (lim.cpu || '—'));
        if (req.memory || lim.memory) resStr.push('Mem: ' + (req.memory || '—') + ' / ' + (lim.memory || '—'));
        detailRows += '<div class="ov-row"><span class="ov-label">Resources</span><span class="ov-val mono">' + resStr.join('  ·  ') + '</span></div>';
      }
      if ((spec.configMaps || []).length || (spec.secrets || []).length) {
        var vols = (spec.configMaps || []).map(function (c) { return '<span class="ov-tag">' + _esc(c.name) + '</span>'; }).concat((spec.secrets || []).map(function (s) { return '<span class="ov-tag ov-tag-secret">' + _esc(s.name) + ' <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>'; }));
        detailRows += '<div class="ov-row"><span class="ov-label">Volumes</span><span class="ov-val">' + vols.join('') + '</span></div>';
      }
      if ((spec.pvcs || []).length) {
        detailRows += '<div class="ov-row"><span class="ov-label">PVCs</span><span class="ov-val">' + spec.pvcs.map(function (p) { return '<span class="ov-tag">' + _esc(p.name) + ' (' + _esc(p.storage) + ')</span>'; }).join('') + '</span></div>';
      }
      if (detailRows) {
        overviewHtml += '<div class="ov-detail-grid">' + detailRows + '</div>';
      }

      if ((spec.ports || []).length) {
        overviewHtml += '<div class="app-proxy-urls"><div class="app-proxy-urls-label">Proxy</div>';
        (spec.ports || []).forEach(function (p) {
          var portNum = p.port || 80;
          var setupId = 'modal-proxy-setup-' + portNum;
          if (!_proxyDomain) {
            overviewHtml +=
              '<div class="app-proxy-url-row">' +
                '<span class="app-proxy-port-badge">' + portNum + (p.name ? ' · ' + _esc(p.name) : '') + '</span>' +
                '<span class="text-muted" style="font-size:0.8rem;">Set <span class="mono">apiDomain</span> in Helm values to enable CNAME access</span>' +
              '</div>';
          } else {
            var hostname = app.name + '-' + portNum + '.' + _proxyDomain;
            overviewHtml +=
              '<div class="app-proxy-url-row">' +
                '<span class="app-proxy-port-badge">' + portNum + (p.name ? ' · ' + _esc(p.name) : '') + '</span>' +
                '<code class="app-proxy-url-val mono" id="modal-proxy-url-' + portNum + '">' + _esc(hostname) + '</code>' +
                '<button type="button" class="app-proxy-copy btn-icon" data-url="' + _esc(hostname) + '" title="Copy hostname" aria-label="Copy proxy hostname">' +
                  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                '</button>' +
                '<button type="button" class="btn-sm proxy-setup-toggle" aria-expanded="false" data-target="' + setupId + '" style="margin-left:0.25rem;">Setup</button>' +
              '</div>' +
              '<div id="' + setupId + '" class="proxy-setup-wrap" style="display:none;">' + _proxySetupInstructions(app.name, portNum) + '</div>';
          }
        });
        overviewHtml += '</div>';
      }
      // Delete danger zone
      var deleteLabel = isSubmitted ? 'Delete workload' : 'Stop execution';
      overviewHtml +=
        '<div class="app-danger-zone">' +
          '<div class="app-danger-zone-label">Danger zone</div>' +
          '<div class="app-danger-zone-row">' +
            '<div class="app-danger-zone-desc">' + (isSubmitted ? 'Permanently removes this workload from the peer cluster.' : 'Stops executing this workload on this cluster.') + '</div>' +
            '<button type="button" class="btn-sm btn-danger app-modal-delete-btn">' + deleteLabel + '</button>' +
          '</div>' +
        '</div>';

      // ── Logs tab ──────────────────────────────────────────────
      var logsHtml =
        '<div class="exec-toolbar">' +
          '<div class="exec-toolbar-left">' +
            '<div class="exec-ctrl exec-ctrl-pod">' +
              '<span class="exec-ctrl-label">Pod</span>' +
              '<select id="logs-pod-select" class="exec-native-sel custom-dd-init"><option value="">All pods</option></select>' +
            '</div>' +
            '<div class="exec-ctrl exec-ctrl-tail">' +
              '<span class="exec-ctrl-label">Tail</span>' +
              '<select id="logs-tail-select" class="exec-native-sel custom-dd-init">' +
                '<option value="50">50</option><option value="100" selected>100</option><option value="200">200</option><option value="500">500</option>' +
              '</select>' +
            '</div>' +
            '<button type="button" class="exec-wrap-btn active" id="logs-wrap-btn" title="Toggle line wrap" aria-label="Toggle line wrap" aria-pressed="true"></button>' +
          '</div>' +
          '<div class="exec-toolbar-right">' +
            '<button type="button" class="btn-sm" id="modal-logs-refresh" style="min-height:28px;font-size:0.78rem;">Refresh</button>' +
          '</div>' +
        '</div>' +
        '<div class="exec-terminal-wrap" id="logs-terminal-wrap"></div>' +
        '<div class="exec-statusbar" id="logs-statusbar"><span id="logs-statusbar-text">Loading…</span></div>';

      // ── Config tab ────────────────────────────────────────────
      var configHtml = _buildConfigTab(spec, isSubmitted);

      // ── YAML tab ──────────────────────────────────────────────
      var crYaml = d.cr_yaml || '';
      var crLineCount = crYaml ? crYaml.split('\n').length : 1;
      var crEditorPx = Math.max(240, Math.min(600, crLineCount * 19 + 16));
      var editHtml = isSubmitted
        ? '<div class="cr-yaml-section">' +
            '<p class="text-sm text-muted" style="margin-bottom:0.75rem;">Edit the full CR YAML and save to apply changes.</p>' +
            '<div class="monaco-editor-wrap" id="modal-spec-editor-wrap">' +
              '<div id="modal-spec-editor-host" class="monaco-editor-host" style="height:' + crEditorPx + 'px;" aria-label="CR YAML editor"></div>' +
              '<textarea id="modal-spec-textarea" class="monaco-fallback-textarea modal-spec-editor" rows="' + crLineCount + '" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-spec-yaml="' + _esc(crYaml) + '">' + _esc(crYaml) + '</textarea>' +
            '</div>' +
          '</div>'
        : '<div class="cr-yaml-section">' +
            '<pre class="cr-yaml-block">' + _esc(crYaml) + '</pre>' +
          '</div>';

      // ── Terminal tab ──────────────────────────────────────────
      var termHtml =
        '<div class="exec-toolbar">' +
          '<div class="exec-toolbar-left">' +
            '<div class="exec-ctrl exec-ctrl-pod">' +
              '<span class="exec-ctrl-label">Pod</span>' +
              '<select id="exec-pod-select" class="exec-native-sel custom-dd-init"><option value="">Loading…</option></select>' +
            '</div>' +
            '<div class="exec-ctrl exec-ctrl-shell">' +
              '<span class="exec-ctrl-label">Shell</span>' +
              '<select id="exec-shell-select" class="exec-native-sel custom-dd-init">' +
                '<option value="/bin/sh">/bin/sh</option>' +
                '<option value="/bin/bash" selected>/bin/bash</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<div class="exec-toolbar-right">' +
            '<div class="exec-status" id="exec-status"><span class="exec-status-dot"></span><span class="exec-status-text">Disconnected</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="exec-terminal-wrap" id="exec-terminal-wrap"></div>' +
        '<div class="exec-statusbar" id="exec-statusbar">' +
          '<span id="exec-statusbar-text">Initializing…</span>' +
        '</div>';

      // ── Assemble tabs ─────────────────────────────────────────
      var podReady = app.status === 'Running' || app.status === 'Ready';
      var configTabDisabled = !podReady;
      var termTabDisabled = !podReady;

      // Tabs bar goes OUTSIDE the scrollable body (fixed above it)
      var tabsBar = el('app-modal-tabs-bar');
      if (tabsBar) {
        tabsBar.innerHTML =
          '<div class="modal-tabs">' +
            '<button type="button" class="modal-tab active" data-tab="overview">Overview</button>' +
            '<button type="button" class="modal-tab" data-tab="logs">Logs</button>' +
            (isSubmitted ? '<button type="button" class="modal-tab' + (termTabDisabled ? ' modal-tab-disabled' : '') + '" data-tab="terminal"' + (termTabDisabled ? ' disabled title="Available when pod is Running"' : '') + '>Terminal</button>' : '') +
            (isSubmitted ? '<button type="button" class="modal-tab' + (configTabDisabled ? ' modal-tab-disabled' : '') + '" data-tab="config"' + (configTabDisabled ? ' disabled title="Available when pod is Running"' : '') + '>Config</button>' : '') +
            '<button type="button" class="modal-tab" data-tab="edit">YAML</button>' +
          '</div>';
      }

      body.innerHTML =
        '<div class="modal-tab-panel active" data-panel="overview">' + overviewHtml + '</div>' +
        '<div class="modal-tab-panel modal-tab-panel-terminal" data-panel="logs">' + logsHtml + '</div>' +
        (isSubmitted ? '<div class="modal-tab-panel modal-tab-panel-terminal" data-panel="terminal">' + termHtml + '</div>' : '') +
        (isSubmitted ? '<div class="modal-tab-panel" data-panel="config"><div id="cfg-panel-body"' + (configTabDisabled ? ' style="opacity:0.4;pointer-events:none;"' : '') + '>' + configHtml + '</div></div>' : '') +
        '<div class="modal-tab-panel" data-panel="edit">' + editHtml + '</div>';
      if (initialTab) _showModalTab(initialTab);
      initCustomDropdowns();
      initExecDropdowns();
      initNumSpinners();

      // Wire proxy setup toggle buttons in the overview panel
      var overviewPanel = body.querySelector('[data-panel="overview"]');
      if (overviewPanel) {
        var modalToggles = overviewPanel.querySelectorAll('.proxy-setup-toggle');
        for (var mi = 0; mi < modalToggles.length; mi++) {
          modalToggles[mi].addEventListener('click', function () {
            var targetId = this.getAttribute('data-target');
            var wrap = el(targetId);
            if (!wrap) return;
            var open = wrap.style.display !== 'none';
            wrap.style.display = open ? 'none' : 'block';
            this.setAttribute('aria-expanded', open ? 'false' : 'true');
            this.textContent = open ? 'Setup' : 'Hide';
          });
        }
      }

      // Wire up config KV editors after DOM is built
      (spec.configMaps || []).forEach(function (cm, i) {
        _buildKvEditor('cfg-cm-' + i, app.id, 'configmap', cm.name, !isSubmitted);
      });
      (spec.secrets || []).forEach(function (sec, i) {
        _buildKvEditor('cfg-sec-' + i, app.id, 'secret', sec.name, !isSubmitted);
      });

      // Config save — delegated via footer (button is injected by _showModalTab)
      function _doCfgSave(btn) {
        btn.disabled = true; btn.textContent = 'Saving…';
        var newSpec = JSON.parse(JSON.stringify(spec));
        var hasNewEntries = false;
        ['configmap', 'secret'].forEach(function (kind) {
          var name = (el('add-' + kind + '-name') || {}).value || '';
          var mount = (el('add-' + kind + '-mount') || {}).value || '';
          if (!name.trim() || !mount.trim()) return;
          hasNewEntries = true;
          var kvPairs = _readAddKvEditor('add-' + kind + '-kv');
          var entryData = {};
          kvPairs.forEach(function (p) { if (p.key) entryData[p.key] = p.value; });
          var entry = { name: name.trim(), mountPath: mount.trim() };
          if (Object.keys(entryData).length) entry.data = entryData;
          if (kind === 'configmap') { newSpec.configMaps = (newSpec.configMaps || []).concat([entry]); }
          else { newSpec.secrets = (newSpec.secrets || []).concat([entry]); }
        });
        var pvcName = (el('add-pvc-name') || {}).value || '';
        var pvcMount = (el('add-pvc-mount') || {}).value || '';
        var pvcStorage = (el('add-pvc-storage') || {}).value || '1Gi';
        var pvcMode = (el('add-pvc-mode') || {}).value || 'ReadWriteOnce';
        if (pvcName.trim() && pvcMount.trim()) {
          hasNewEntries = true;
          newSpec.pvcs = (newSpec.pvcs || []).concat([{ name: pvcName.trim(), mountPath: pvcMount.trim(), storage: pvcStorage.trim(), accessMode: pvcMode }]);
        }
        var doKvPatches = function () {
          var patches = Object.values(_kvEditors).filter(function (ed) {
            return ed.dirty;
          }).map(function (ed) {
            var data = ed.collect();
            var url = P.API_BASE + '/remoteapp/' + ed.appId + '/config/' + ed.kind + '/' + encodeURIComponent(ed.volName);
            return fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: data }) })
              .then(function (r) { return r.json(); })
              .then(function (res) { if (!res.ok) throw new Error(res.error || 'patch failed'); });
          });
          return Promise.all(patches);
        };
        var work = hasNewEntries ? P.updateAppSpec(app.id, _specToYaml(newSpec)) : doKvPatches();
        work.then(function () {
          toast('Saved', 'ok');
          closeAppModal();
          refresh();
        }).catch(function (err) {
          toast('Error: ' + err.message, 'error');
          btn.disabled = false; btn.textContent = 'Save';
        });
      }

      // YAML save — extract spec from full CR, patch it
      function _doSpecSave(btn) {
        var crStr = window.PorpulsionVscodeEditor
          ? window.PorpulsionVscodeEditor.getModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea')
          : (el('modal-spec-textarea') || {}).value || '';
        if (!crStr.trim()) { toast('YAML cannot be empty', 'error'); return; }
        btn.disabled = true; btn.textContent = 'Saving…';
        P.updateAppSpec(app.id, crStr).then(function () {
          toast('Saved', 'ok');
          closeAppModal();
          refresh();
        }).catch(function (err) {
          toast('Error: ' + err.message, 'error');
          btn.disabled = false; btn.textContent = 'Save';
        });
      }

      // Footer event delegation — replace the footer element each open so listeners don't stack
      var footer = el('app-modal-footer');
      if (footer) {
        var newFooter = footer.cloneNode(false);
        footer.parentNode.replaceChild(newFooter, footer);
        newFooter.addEventListener('click', function (e) {
          var btn = e.target.closest('button');
          if (!btn) return;
          if (btn.id === 'cfg-tab-save') _doCfgSave(btn);
          else if (btn.id === 'spec-tab-save') _doSpecSave(btn);
        });
      }

      if (isSubmitted) {
        // Toggle add-form sections open/closed and init KV editors
        body.querySelectorAll('.cfg-add-header').forEach(function (hdr) {
          hdr.addEventListener('click', function () {
            var bodyEl = el(hdr.dataset.toggle + '-body');
            if (!bodyEl) return;
            var nowHidden = bodyEl.hidden;
            bodyEl.hidden = !nowHidden;
            hdr.classList.toggle('open', nowHidden);
            if (nowHidden) {
              var isSecret = hdr.dataset.toggle === 'add-secret';
              var kvId = hdr.dataset.toggle + '-kv';
              var kvEl = el(kvId);
              if (kvEl && !kvEl.dataset.init) { kvEl.dataset.init = '1'; _initAddKvEditor(kvEl, isSecret); }
            }
          });
        });

        // Delete handlers for existing ConfigMaps, Secrets, PVCs
        function _makeDeleteHandler(listKey, idx, label) {
          return function () {
            showConfirm('Remove ' + label + '?', 'This will remove it from the spec and trigger a redeploy.', 'Remove', 'btn-danger', function () {
              var newSpec = JSON.parse(JSON.stringify(spec));
              newSpec[listKey] = (newSpec[listKey] || []).filter(function (_, j) { return j !== idx; });
              P.updateAppSpec(app.id, _specToYaml(newSpec)).then(function () {
                toast(label + ' removed', 'ok');
                refresh();
                openAppModal(app.id, 'config');
              }).catch(function (err) {
                toast('Error: ' + err.message, 'error');
              });
            });
          };
        }
        (spec.configMaps || []).forEach(function (cm, i) {
          var btn = body.querySelector('.cfg-cm-del-' + i);
          if (btn) btn.addEventListener('click', _makeDeleteHandler('configMaps', i, 'ConfigMap "' + cm.name + '"'));
        });
        (spec.secrets || []).forEach(function (sec, i) {
          var btn = body.querySelector('.cfg-sec-del-' + i);
          if (btn) btn.addEventListener('click', _makeDeleteHandler('secrets', i, 'Secret "' + sec.name + '"'));
        });
        (spec.pvcs || []).forEach(function (pvc, i) {
          var btn = body.querySelector('.cfg-pvc-del-' + i);
          if (btn) btn.addEventListener('click', _makeDeleteHandler('pvcs', i, 'PVC "' + pvc.name + '"'));
        });
      }

      // Tab click — tabs now live in tabsBar, not body
      var tabClickRoot = el('app-modal-tabs-bar') || body;
      tabClickRoot.querySelectorAll('.modal-tab').forEach(function (t) {
        t.addEventListener('click', function () {
          if (t.disabled || t.classList.contains('modal-tab-disabled')) return;
          _showModalTab(t.dataset.tab);
        });
      });

      // Logs refresh
      var logsRefreshBtn = el('modal-logs-refresh');
      if (logsRefreshBtn) logsRefreshBtn.addEventListener('click', _fetchModalLogs);
      var logsPodSel = el('logs-pod-select');
      if (logsPodSel) logsPodSel.addEventListener('change', _fetchModalLogs);
      var logsTailSel = el('logs-tail-select');
      if (logsTailSel) logsTailSel.addEventListener('change', _fetchModalLogs);

      // Logs wrap toggle — build SVG via DOM to guarantee correct namespace parsing
      var logsWrapBtn = el('logs-wrap-btn');
      if (logsWrapBtn) {
        logsWrapBtn.innerHTML = '';
        var wrapSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        wrapSvg.setAttribute('width', '15'); wrapSvg.setAttribute('height', '15');
        wrapSvg.setAttribute('viewBox', '0 0 15 15'); wrapSvg.setAttribute('fill', 'none');
        wrapSvg.setAttribute('aria-hidden', 'true');
        [
          'M1 2.5H14', 'M1 6H14', 'M1 9.5H9',
          'M11 7.5L13.5 9.5L11 11.5', 'M13.5 9.5H8'
        ].forEach(function (d) {
          var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          p.setAttribute('d', d);
          p.setAttribute('stroke', 'currentColor');
          p.setAttribute('stroke-width', '1.5');
          p.setAttribute('stroke-linecap', 'round');
          p.setAttribute('stroke-linejoin', 'round');
          wrapSvg.appendChild(p);
        });
        logsWrapBtn.appendChild(wrapSvg);
        logsWrapBtn.addEventListener('click', function () {
          var wrapOn = logsWrapBtn.classList.toggle('active');
          logsWrapBtn.setAttribute('aria-pressed', wrapOn ? 'true' : 'false');
          var logsWrap = el('logs-terminal-wrap');
          if (_logsTerm) {
            if (wrapOn) {
              // Wrap on: refit to container width, remove horizontal scroll
              if (logsWrap) logsWrap.classList.remove('nowrap');
              if (_logsFitAddon) { try { _logsFitAddon.fit(); } catch(e) {} }
            } else {
              // Wrap off: widen terminal beyond container, enable horizontal scroll
              if (logsWrap) logsWrap.classList.add('nowrap');
              try { _logsTerm.resize(500, _logsTerm.rows); } catch(e) {}
            }
          }
        });
      }

      // Terminal exec — xterm.js handles all input, just wire up pod/shell selects
      var execPodSel = el('exec-pod-select');
      var execShellSel = el('exec-shell-select');
      function _execReconnect() {
        // Ignore programmatic changes during pod-list population
        if (_execInitializing) return;
        var pod = execPodSel ? execPodSel.value : '';
        if (!pod) return;
        _execConnect(pod);
      }
      if (execPodSel) execPodSel.addEventListener('change', _execReconnect);
      if (execShellSel) execShellSel.addEventListener('change', _execReconnect);

      // Proxy URL copy buttons
      body.querySelectorAll('.app-proxy-copy').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var url = btn.dataset.url || '';
          navigator.clipboard.writeText(url).then(function () {
            var orig = btn.innerHTML;
            btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            btn.style.color = 'var(--green)';
            setTimeout(function () { btn.innerHTML = orig; btn.style.color = ''; }, 1500);
          }).catch(function () {});
        });
      });

      // Delete
      var delBtn = body.querySelector('.app-modal-delete-btn');
      if (delBtn) {
        delBtn.addEventListener('click', function () {
          var modalDeleteMsg = isSubmitted
            ? 'Delete "' + _esc(app.name || app.id) + '" and remove it from the peer cluster. This cannot be undone.'
            : 'Stop executing "' + _esc(app.name || app.id) + '" on this cluster. The peer that submitted it may re-deploy it.';
          showConfirm('Delete workload?', modalDeleteMsg, 'Delete', 'btn-danger', function () { deleteApp(app.id, app.name); });
        });
      }
    }).catch(function (err) {
      body.innerHTML = '<p style="color:var(--red)">Error: ' + _esc(err.message) + '</p>';
    });
  }

  function closeAppModal() {
    _currentAppId = null;
    if (_execWs) { try { _execWs.close(); } catch(e) {} _execWs = null; }
    _execDestroyTerminal();
    _logsDestroyTerminal();
    var body = el('app-modal-body');
    if (body) body.classList.remove('modal-body-terminal');
    var footer = el('app-modal-footer');
    if (footer) { footer.style.display = 'none'; footer.innerHTML = ''; }
    var modal = el('app-modal');
    if (modal) modal.classList.remove('open');
    document.documentElement.style.overflowX = '';
    if (window.PorpulsionVscodeEditor) {
      window.PorpulsionVscodeEditor.disposeModalSpecEditor('modal-spec-editor-host');
    }
  }

  function deleteApp(id, name) {
    P.deleteApp(id).then(function () {
      toast('Deleted ' + (name || id), 'ok');
      closeAppModal();
      refresh();
    }).catch(function (err) { toast('Error: ' + err.message, 'error'); refresh(); });
  }

  function removePeer(name) {
    P.removePeer(name).then(function () { toast('Removed ' + name, 'ok'); refresh(); }).catch(function (err) { toast(err.message, 'error'); refresh(); });
  }

  var appModal = el('app-modal');
  if (appModal) appModal.addEventListener('click', function (e) { if (e.target === this) closeAppModal(); });
  var appModalClose = el('app-modal-close');
  if (appModalClose) appModalClose.addEventListener('click', closeAppModal);

  var peerModal = el('peer-modal');
  if (peerModal) peerModal.addEventListener('click', function (e) { if (e.target === this) this.classList.remove('open'); });
  var peerModalClose = el('peer-modal-close');
  if (peerModalClose) peerModalClose.addEventListener('click', function () { peerModal && peerModal.classList.remove('open'); });

  // ── Notifications bell ──────────────────────────────────────

  function renderNotifications(notifications) {
    var badge = el('notif-badge');
    var list  = el('notif-list');
    if (!badge || !list) return;

    var unread = (notifications || []).filter(function (n) { return !n.ack; }).length;
    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.style.display = '';
      var bellBtn = el('notif-bell');
      if (bellBtn) bellBtn.classList.add('has-unread');
    } else {
      badge.style.display = 'none';
      var bellBtn = el('notif-bell');
      if (bellBtn) bellBtn.classList.remove('has-unread');
    }

    if (!notifications || notifications.length === 0) {
      list.innerHTML = '<div class="notif-empty">No notifications</div>';
      return;
    }

    list.innerHTML = '';
    (notifications || []).forEach(function (n) {
      var item = document.createElement('div');
      item.className = 'notif-item' + (n.ack ? ' acked' : '');
      item.dataset.notifId = n.id;

      var dot = document.createElement('span');
      dot.className = 'notif-dot ' + (n.level || 'info');

      var content = document.createElement('div');
      content.className = 'notif-content';

      var titleEl = document.createElement('div');
      titleEl.className = 'notif-title';
      titleEl.textContent = n.title;

      var msgEl = document.createElement('div');
      msgEl.className = 'notif-msg';
      msgEl.textContent = n.message || '';

      var tsEl = document.createElement('div');
      tsEl.className = 'notif-ts';
      tsEl.innerHTML = timeAgo(n.ts);

      content.appendChild(titleEl);
      content.appendChild(msgEl);

      // Add show-more toggle if the message is long (more than ~120 chars or has newlines)
      var isLong = (n.message || '').length > 120 || (n.message || '').indexOf('\n') !== -1;
      if (isLong) {
        var moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'notif-show-more';
        moreBtn.textContent = 'Show more';
        moreBtn.addEventListener('click', function () {
          var expanded = msgEl.classList.toggle('expanded');
          moreBtn.textContent = expanded ? 'Show less' : 'Show more';
        });
        content.appendChild(moreBtn);
      }

      content.appendChild(tsEl);

      var dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'notif-dismiss';
      dismiss.dataset.notifId = n.id;
      dismiss.title = 'Dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.innerHTML = '&#x2715;';

      item.appendChild(dot);
      item.appendChild(content);
      item.appendChild(dismiss);
      list.appendChild(item);
    });
  }

  // Bell toggle
  (function () {
    var bellBtn  = el('notif-bell');
    var panel    = el('notif-panel');
    var clearBtn = el('notif-clear-btn');
    if (!bellBtn || !panel) return;

    bellBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !panel.hidden;
      panel.hidden = open;
      bellBtn.setAttribute('aria-expanded', String(!open));
      if (!open) {
        // Ack all when panel is opened so badge clears (but items stay visible)
        P.getNotifications().then(function (notifs) {
          notifs.filter(function (n) { return !n.ack; }).forEach(function (n) {
            P.ackNotification(n.id).catch(function () {});
          });
          // Mark acked in UI (dims them slightly) but keep them listed
          renderNotifications(notifs.map(function (n) { return Object.assign({}, n, { ack: true }); }));
        }).catch(function () {});
      }
    });

    document.addEventListener('click', function (e) {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== bellBtn) {
        panel.hidden = true;
        bellBtn.setAttribute('aria-expanded', 'false');
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        P.clearNotifications().then(function () {
          renderNotifications([]);
          panel.hidden = true;
          bellBtn.setAttribute('aria-expanded', 'false');
        }).catch(function (err) { toast(err.message, 'error'); });
      });
    }

    // Dismiss individual
    el('notif-list') && el('notif-list').addEventListener('click', function (e) {
      var btn = e.target.closest('.notif-dismiss');
      if (!btn) return;
      var id = btn.dataset.notifId;
      if (!id) return;
      P.deleteNotification(id).then(function () {
        P.getNotifications().then(renderNotifications).catch(function () {});
      }).catch(function (err) { toast(err.message, 'error'); });
    });
  })();

  // ── Custom number spinners ─────────────────────────────────────
  function initNumSpinners() {
    document.querySelectorAll('input[type="number"]:not(.num-spinner-init)').forEach(function (inp) {
      inp.classList.add('num-spinner-init');
      var min = inp.hasAttribute('min') ? parseFloat(inp.min) : -Infinity;
      var max = inp.hasAttribute('max') ? parseFloat(inp.max) : Infinity;
      var step = inp.step && parseFloat(inp.step) > 0 ? parseFloat(inp.step) : 1;
      var wrap = document.createElement('div');
      wrap.className = 'num-input-wrap';
      inp.parentNode.insertBefore(wrap, inp);
      var btnMinus = document.createElement('button');
      btnMinus.type = 'button';
      btnMinus.className = 'num-spin-btn';
      btnMinus.setAttribute('aria-label', 'Decrease');
      btnMinus.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6h8"/></svg>';
      var btnPlus = document.createElement('button');
      btnPlus.type = 'button';
      btnPlus.className = 'num-spin-btn';
      btnPlus.setAttribute('aria-label', 'Increase');
      btnPlus.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 2v8M2 6h8"/></svg>';
      wrap.appendChild(btnMinus);
      wrap.appendChild(inp);
      wrap.appendChild(btnPlus);
      function update(delta) {
        var cur = inp.value === '' ? (min !== -Infinity ? min : 0) : parseFloat(inp.value);
        var next = Math.round((cur + delta) / step) * step;
        if (next < min) next = min;
        if (next > max) next = max;
        inp.value = next;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      btnMinus.addEventListener('click', function () { update(-step); });
      btnPlus.addEventListener('click', function () { update(step); });
    });
  }

  // ── Custom dropdown (replaces <select> with JS-driven panel) ──
  function initCustomDropdowns() {
    document.querySelectorAll('select:not(.custom-dd-init):not(.logs-tail-select):not(.exec-native-sel)').forEach(function (sel) {
      if (sel.closest('.exec-ctrl')) return;
      sel.classList.add('custom-dd-init');
      var wrap = document.createElement('div');
      wrap.className = 'custom-dd';
      sel.parentNode.insertBefore(wrap, sel);
      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'custom-dd-trigger';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      var label = document.createElement('span');
      label.className = 'custom-dd-label';
      var chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('class', 'custom-dd-chevron');
      chevron.setAttribute('width', '12');
      chevron.setAttribute('height', '12');
      chevron.setAttribute('viewBox', '0 0 12 12');
      chevron.setAttribute('fill', 'none');
      chevron.setAttribute('stroke', 'currentColor');
      chevron.setAttribute('stroke-width', '1.8');
      chevron.setAttribute('stroke-linecap', 'round');
      chevron.setAttribute('stroke-linejoin', 'round');
      chevron.setAttribute('aria-hidden', 'true');
      var chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      chevPath.setAttribute('d', 'M2 4l4 4 4-4');
      chevron.appendChild(chevPath);
      trigger.appendChild(label);
      trigger.appendChild(chevron);
      var panel = document.createElement('div');
      panel.className = 'custom-dd-panel';
      panel.setAttribute('role', 'listbox');
      panel.style.display = 'none';
      wrap.appendChild(trigger);
      document.body.appendChild(panel);
      sel.style.display = 'none';
      wrap.appendChild(sel);
      function syncLabel() {
        var opt = sel.options[sel.selectedIndex];
        var isPlaceholder = opt && (opt.disabled || opt.value === '') && opt.hidden !== false;
        if (isPlaceholder || !opt) {
          label.textContent = '';
          label.dataset.placeholder = opt ? opt.text : '';
        } else {
          label.textContent = opt.text;
          label.dataset.placeholder = '';
        }
      }
      function buildOptions() {
        panel.innerHTML = '';
        Array.from(sel.options).forEach(function (opt, idx) {
          if (opt.disabled && opt.hidden) return;
          var item = document.createElement('div');
          item.className = 'custom-dd-option' + (idx === sel.selectedIndex ? ' selected' : '');
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', idx === sel.selectedIndex ? 'true' : 'false');
          item.dataset.idx = idx;
          item.textContent = opt.text;
          item.addEventListener('click', function () {
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            syncLabel();
            closePanel();
          });
          panel.appendChild(item);
        });
      }
      function positionPanel() {
        var rect = trigger.getBoundingClientRect();
        var panelH = panel.scrollHeight;
        var spaceBelow = window.innerHeight - rect.bottom;
        var flipUp = spaceBelow < panelH + 8 && rect.top > panelH + 8;
        panel.style.position = 'fixed';
        panel.style.width = rect.width + 'px';
        panel.style.left = rect.left + 'px';
        panel.style.zIndex = '9999';
        if (flipUp) {
          panel.style.top = '';
          panel.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        } else {
          panel.style.bottom = '';
          panel.style.top = (rect.bottom + 4) + 'px';
        }
      }
      function openPanel() {
        buildOptions();
        panel.style.display = '';
        trigger.setAttribute('aria-expanded', 'true');
        trigger.classList.add('open');
        requestAnimationFrame(function () { positionPanel(); });
      }
      function closePanel() {
        panel.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.classList.remove('open');
      }
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        if (panel.style.display === 'none') openPanel(); else closePanel();
      });
      document.addEventListener('click', function (e) {
        if (!wrap.contains(e.target) && !panel.contains(e.target)) closePanel();
      }, true);
      window.addEventListener('scroll', function () { if (panel.style.display !== 'none') positionPanel(); }, true);
      trigger.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (panel.style.display === 'none') openPanel(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); if (panel.style.display === 'none') openPanel(); }
        if (e.key === 'Escape') closePanel();
      });
      sel.addEventListener('change', function () { syncLabel(); });
      if (window.MutationObserver) {
        var mo = new MutationObserver(function () { syncLabel(); });
        mo.observe(sel, { childList: true, subtree: false });
      }
      sel._ddRebuild = function () { buildOptions(); syncLabel(); };
      syncLabel();
      if (sel.id) { trigger.setAttribute('aria-controls', 'dd-panel-' + sel.id); panel.id = 'dd-panel-' + sel.id; }
      if (sel.hasAttribute('aria-label')) trigger.setAttribute('aria-label', sel.getAttribute('aria-label'));
    });
  }

  // ── Exec-toolbar chip dropdowns ───────────────────────────────────────────
  // Compact custom dropdown for label+select chips in logs/terminal toolbars.
  // Builds a slim trigger that sits inside .exec-ctrl, drops a panel via fixed
  // positioning so it escapes any overflow:hidden container.
  function initExecDropdowns() {
    document.querySelectorAll('.exec-ctrl select').forEach(function (sel) {
      if (sel._execDdInit) return;
      sel._execDdInit = true;
      sel.style.display = 'none';

      // Trigger: fills the right half of the chip
      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'exec-dd-trigger';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      if (sel.getAttribute('aria-label')) trigger.setAttribute('aria-label', sel.getAttribute('aria-label'));

      var lbl = document.createElement('span');
      lbl.className = 'exec-dd-label';
      var chevEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevEl.setAttribute('width', '10'); chevEl.setAttribute('height', '10');
      chevEl.setAttribute('viewBox', '0 0 10 10');
      chevEl.setAttribute('fill', 'none'); chevEl.setAttribute('stroke', 'currentColor');
      chevEl.setAttribute('stroke-width', '1.8');
      chevEl.setAttribute('stroke-linecap', 'round'); chevEl.setAttribute('stroke-linejoin', 'round');
      chevEl.setAttribute('class', 'exec-dd-arrow'); chevEl.setAttribute('aria-hidden', 'true');
      var cp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      cp.setAttribute('d', 'M1 3l4 4 4-4'); chevEl.appendChild(cp);
      trigger.appendChild(lbl); trigger.appendChild(chevEl);
      sel.parentNode.insertBefore(trigger, sel);

      // Panel: appended to body, positioned fixed
      var panel = document.createElement('div');
      panel.className = 'exec-dd-panel';
      panel.setAttribute('role', 'listbox');
      panel.style.display = 'none';
      document.body.appendChild(panel);

      function syncLabel() {
        var opt = sel.options[sel.selectedIndex];
        lbl.textContent = opt ? opt.text : '';
      }
      function buildOptions() {
        panel.innerHTML = '';
        Array.from(sel.options).forEach(function (opt, idx) {
          var item = document.createElement('div');
          item.className = 'exec-dd-option' + (idx === sel.selectedIndex ? ' selected' : '');
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', idx === sel.selectedIndex ? 'true' : 'false');
          item.textContent = opt.text;
          item.addEventListener('mousedown', function (e) { e.preventDefault(); });
          item.addEventListener('click', function () {
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            syncLabel(); closePanel();
          });
          panel.appendChild(item);
        });
      }
      function positionPanel() {
        var r = trigger.getBoundingClientRect();
        var ph = panel.scrollHeight || 120;
        var spaceBelow = window.innerHeight - r.bottom;
        panel.style.position = 'fixed';
        panel.style.minWidth = Math.max(r.width, 120) + 'px';
        panel.style.left = r.left + 'px';
        panel.style.zIndex = '9999';
        if (spaceBelow < ph + 8 && r.top > ph + 8) {
          panel.style.top = ''; panel.style.bottom = (window.innerHeight - r.top + 4) + 'px';
        } else {
          panel.style.bottom = ''; panel.style.top = (r.bottom + 4) + 'px';
        }
      }
      function openPanel() {
        buildOptions(); panel.style.display = '';
        trigger.setAttribute('aria-expanded', 'true');
        trigger.classList.add('open');
        requestAnimationFrame(positionPanel);
      }
      function closePanel() {
        panel.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.classList.remove('open');
      }
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        if (panel.style.display === 'none') openPanel(); else closePanel();
      });
      document.addEventListener('click', function (e) {
        if (!trigger.contains(e.target) && !panel.contains(e.target)) closePanel();
      }, true);
      window.addEventListener('scroll', function () {
        if (panel.style.display !== 'none') positionPanel();
      }, true);
      trigger.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (panel.style.display === 'none') openPanel(); }
        if (e.key === 'Escape') closePanel();
      });
      sel.addEventListener('change', syncLabel);
      if (window.MutationObserver) {
        new MutationObserver(syncLabel).observe(sel, { childList: true });
      }
      sel._execDdRebuild = function () { syncLabel(); };
      syncLabel();
    });
  }

  (function bindSettings() {
    var logLevelCtrl = el('setting-log-level');
    if (logLevelCtrl) {
      logLevelCtrl.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-val]');
        if (!btn) return;
        setSegVal('setting-log-level', btn);
        saveSetting('log_level', btn.dataset.val);
      });
    }

    function bindChk(id, key) {
      var e = el(id);
      if (e) e.addEventListener('change', function () { saveSetting(key, e.checked); });
    }
    bindChk('setting-inbound-apps',         'allow_inbound_remoteapps');
    bindChk('setting-require-approval',     'require_remoteapp_approval');
    bindChk('setting-require-res-requests', 'require_resource_requests');
    bindChk('setting-require-res-limits',   'require_resource_limits');
    bindChk('setting-allow-pvcs',           'allow_pvcs');
    bindChk('setting-inbound-tunnels',      'allow_inbound_tunnels');
    bindChk('setting-registry-pull-enabled', 'registry_pull_enabled');

    var regSaveBtn = el('setting-registry-save');
    if (regSaveBtn) {
      regSaveBtn.addEventListener('click', function () {
        regSaveBtn.disabled = true; regSaveBtn.textContent = 'Saving…';
        P.updateSettings({ registry_pull_enabled: (el('setting-registry-pull-enabled') || {}).checked || false })
          .then(function () {
            regSaveBtn.disabled = false; regSaveBtn.textContent = 'Save';
            toast('Registry proxy settings saved', 'ok');
          })
          .catch(function (err) {
            regSaveBtn.disabled = false; regSaveBtn.textContent = 'Save';
            toast(err.message || 'Save failed', 'error');
          });
      });
    }

    var filtersSaveBtn = el('setting-filters-save');
    if (filtersSaveBtn) {
      filtersSaveBtn.addEventListener('click', function () {
        var payload = {
          allowed_source_peers: (el('setting-allowed-peers') || {}).value || '',
          allowed_images:       (el('setting-allowed-images') || {}).value || '',
          blocked_images:       (el('setting-blocked-images') || {}).value || '',
        };
        P.updateSettings(payload).then(function () { toast('Filters saved', 'ok'); }).catch(function (err) { toast(err.message, 'error'); });
      });
    }

    var quotasSaveBtn = el('setting-quotas-save');
    if (quotasSaveBtn) {
      quotasSaveBtn.addEventListener('click', function () {
        var payload = {
          max_cpu_request_per_pod:    (el('setting-max-cpu-req') || {}).value || '',
          max_cpu_limit_per_pod:      (el('setting-max-cpu-lim') || {}).value || '',
          max_memory_request_per_pod: (el('setting-max-mem-req') || {}).value || '',
          max_memory_limit_per_pod:   (el('setting-max-mem-lim') || {}).value || '',
          max_replicas_per_app:       parseInt((el('setting-max-replicas') || {}).value || '0', 10) || 0,
          max_total_deployments:      parseInt((el('setting-max-total-deploys') || {}).value || '0', 10) || 0,
          max_total_pods:             parseInt((el('setting-max-total-pods') || {}).value || '0', 10) || 0,
          max_total_cpu_requests:     (el('setting-max-total-cpu') || {}).value || '',
          max_total_memory_requests:  (el('setting-max-total-mem') || {}).value || '',
          max_pvc_storage_per_pvc_gb: parseInt((el('setting-max-pvc-per') || {}).value || '0', 10) || 0,
          max_pvc_storage_total_gb:   parseInt((el('setting-max-pvc-total') || {}).value || '0', 10) || 0,
        };
        P.updateSettings(payload).then(function () { toast('Quotas saved', 'ok'); }).catch(function (err) { toast(err.message, 'error'); });
      });
    }

    var tunnelsSaveBtn = el('setting-tunnels-save');
    if (tunnelsSaveBtn) {
      tunnelsSaveBtn.addEventListener('click', function () {
        var payload = {
          allow_inbound_tunnels: (el('setting-inbound-tunnels') || {}).checked || false,
          allowed_tunnel_peers: _getTunnelAllowedValue(),
        };
        P.updateSettings(payload).then(function () { toast('Tunnel settings saved', 'ok'); }).catch(function (err) { toast(err.message, 'error'); });
      });
    }

  window.PorpulsionPages = {
    refresh: refresh,
    loadInvite: loadInvite,
    openAppModal: openAppModal,
    closeAppModal: closeAppModal,
    deleteApp: deleteApp,
    removePeer: removePeer,
    initDeploySpecEditor: initDeploySpecEditor,
    showConfirm: showConfirm
  };

  refresh();
  loadInvite();
  loadSettings();
  initNumSpinners();
  initCustomDropdowns();
  setInterval(refresh, 3000);
  setInterval(loadInvite, 5000);
})();
})();
