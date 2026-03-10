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
      ? '<div class="detail-row"><span class="label">Inbound IP</span><span class="mono" style="font-size:0.85rem;">' + _esc(p.remote_addr) + '</span></div>'
      : '';
    var proxyRow = p.registry_proxy_url
      ? '<div class="detail-row"><span class="label">Image proxy</span><span class="mono" style="font-size:0.82rem;word-break:break-all;">' + _esc(p.registry_proxy_url) + '</span></div>'
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
      var typeLabel = a._type === 'submitted' ? '<span class="badge badge-handshake" style="font-size:0.65rem;">outbound</span>' : '<span class="badge badge-inbound" style="font-size:0.65rem;">inbound</span>';
      return '<tr data-app-id="' + _esc(a.id) + '" data-app-name="' + _esc(a.name) + '" data-app-type="' + a._type + '">' +
        '<td><a href="#" class="app-open-link">' + _esc(a.name) + '</a></td>' +
        '<td>' + typeLabel + '</td><td>' + statusBadge(a.status) + '</td>' +
        '<td class="time-ago">' + timeAgo(a.updated_at) + '</td>' +
        '<td><span class="btn-row"><button type="button" class="btn-icon app-detail-btn" title="Detail" aria-label="Detail"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8.5"/><line x1="12" y1="12" x2="12" y2="16"/></svg></button><button type="button" class="btn-icon btn-icon-danger app-delete-btn" title="Delete" aria-label="Delete"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button></span></td></tr>';
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
    var ICON_PROXY_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    body.innerHTML = list.map(function (a) {
      var isDead = a.status === 'Deleted' || a.status === 'Failed' || a.status === 'Timeout';
      var peerVal = a[peerKey] || '—';
      // Inline proxy open button for submitted apps with ports
      var proxyBtn = '';
      if (!showSource && !isDead) {
        var ports = (a.spec && Array.isArray(a.spec.ports) && a.spec.ports.length) ? a.spec.ports : (a.spec && a.spec.port ? [{ port: a.spec.port }] : [{ port: 80 }]);
        var firstPort = typeof ports[0] === 'object' ? (ports[0].port || 80) : ports[0];
        var proxyUrl = window.location.origin + P.API_BASE + '/remoteapp/' + a.id + '/proxy/' + firstPort;
        proxyBtn = '<a href="' + _esc(proxyUrl) + '" target="_blank" rel="noopener" class="btn-icon" title="Open proxy (:' + firstPort + ')" aria-label="Open proxy">' + ICON_PROXY_OPEN + '</a>';
      }
      return '<tr' + (isDead ? ' style="opacity:0.55;"' : '') + ' data-app-id="' + _esc(a.id) + '" data-app-name="' + _esc(a.name) + '"' + typeAttr + '>' +
        '<td><a href="#" class="app-open-link">' + _esc(a.name) + '</a></td>' +
        '<td class="mono col-hide-mobile">' + _esc(a.id) + '</td><td>' + statusBadge(a.status) + '</td>' +
        '<td class="text-muted text-sm col-hide-tablet">' + _esc(peerVal) + '</td>' +
        '<td class="time-ago col-hide-tablet">' + timeAgo(a.updated_at) + '</td>' +
        '<td><span class="btn-row">' + proxyBtn + '<button type="button" class="btn-icon app-detail-btn" title="Detail" aria-label="Detail"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8.5"/><line x1="12" y1="12" x2="12" y2="16"/></svg></button><button type="button" class="btn-icon btn-icon-danger app-delete-btn" title="Delete" aria-label="Delete"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button></span></td></tr>';
    }).join('');
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
    listEl.innerHTML = active.map(function (a) {
      var isDead = a.status === 'Deleted' || a.status === 'Failed' || a.status === 'Timeout';
      var ports = (a.spec && Array.isArray(a.spec.ports) && a.spec.ports.length) ? a.spec.ports : [{ port: (a.spec && a.spec.port) || 80 }];
      var portLinks = ports.map(function (p) {
        var portNum = typeof p === 'object' ? (p.port || 80) : p;
        var portLabel = (p.name ? p.name : 'Port ' + portNum);
        var proxyUrl = window.location.origin + API_BASE + '/remoteapp/' + a.id + '/proxy/' + portNum;
        var copyId = 'proxy-url-' + a.id + '-' + portNum;
        var openBtn = !isDead
          ? '<a href="' + _esc(proxyUrl) + '" target="_blank" rel="noopener" class="btn-sm proxy-open-btn" title="Open :' + portNum + '">' + ICON_OPEN + ' Open</a>'
          : '';
        return '<div class="proxy-port-row">' +
          '<span class="proxy-port-label">' + _esc(portLabel) + ' <span class="mono" style="font-size:0.7rem;color:var(--muted2);">:' + portNum + '</span></span>' +
          '<span id="' + copyId + '" class="proxy-port-url mono" style="font-size:0.7rem;color:var(--muted);" title="' + _esc(proxyUrl) + '">' + _esc(proxyUrl) + '</span>' +
          '<button type="button" class="btn-icon" title="Copy URL" aria-label="Copy URL" data-copy-el="' + copyId + '">' + ICON_COPY + '</button>' +
          openBtn + '</div>';
      }).join('');
      return '<div class="proxy-app-entry">' +
        '<div class="proxy-app-name">' +
        '<strong>' + _esc(a.name) + '</strong>' +
        statusBadge(a.status) +
        '<span class="text-muted text-sm" style="margin-left:auto;font-size:0.75rem;">' + _esc(a.target_peer || '') + '</span>' +
        '<button type="button" class="btn-icon app-detail-btn" title="Detail" aria-label="Detail" data-app-id="' + _esc(a.id) + '">' + ICON_DETAIL + '</button>' +
        '</div>' + portLinks + '</div>';
    }).join('');
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
      if (lastRefresh) lastRefresh.textContent = new Date().toLocaleTimeString();
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

  function _populateHealthGrid(s, selfUrl) {
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
      setChk('setting-inbound-tunnels',     s.allow_inbound_tunnels);
      setChk('setting-registry-pull-enabled', s.registry_pull_enabled);
      setVal('setting-registry-api-url',      s.registry_api_url || '');
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
      // Accordion summaries
      (function () {
        var inboundSummary = el('acc-inbound-summary');
        if (inboundSummary) {
          var parts = [];
          if (!s.allow_inbound_remoteapps) parts.push('disabled');
          else if (s.require_remoteapp_approval) parts.push('approval required');
          else parts.push('open');
          if (s.allowed_source_peers) parts.push('allowlisted');
          inboundSummary.textContent = parts.join(' · ');
        }
        var quotasSummary = el('acc-quotas-summary');
        if (quotasSummary) {
          var qparts = [];
          if (s.max_replicas_per_app) qparts.push('max ' + s.max_replicas_per_app + ' replicas');
          if (s.max_total_deployments) qparts.push(s.max_total_deployments + ' apps');
          if (s.allow_pvcs) qparts.push('PVCs on');
          else qparts.push('no PVCs');
          quotasSummary.textContent = qparts.length ? qparts.join(' · ') : 'default';
        }
        var tunnelsSummary = el('acc-tunnels-summary');
        if (tunnelsSummary) {
          tunnelsSummary.textContent = s.allow_inbound_tunnels ? 'tunnels allowed' : 'tunnels blocked';
        }
        var registrySummary = el('acc-registry-summary');
        if (registrySummary) {
          registrySummary.textContent = s.registry_pull_enabled ? 'proxy on · ' + (s.registry_api_url || '') : 'proxy off';
        }
      })();
      // Health grid (overview page)
      if (el('health-grid')) {
        P.getInvite().then(function (tok) {
          _populateHealthGrid(s, tok.self_url || '');
        }).catch(function () { _populateHealthGrid(s, ''); });
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
          Object.keys(cm.data).forEach(function (k) { lines.push('      ' + k + ': ' + cm.data[k]); });
        }
      });
    }
    if (spec.secrets && spec.secrets.length) {
      lines.push('secrets:');
      spec.secrets.forEach(function (sec) {
        lines.push('  - name: ' + sec.name + '\n    mountPath: ' + (sec.mountPath || ''));
        if (sec.data && Object.keys(sec.data).length) {
          lines.push('    data:');
          Object.keys(sec.data).forEach(function (k) { lines.push('      ' + k + ': ' + sec.data[k]); });
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
    if (!body) return;
    body.querySelectorAll('.modal-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tabName); });
    body.querySelectorAll('.modal-tab-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === tabName); });
    var cfgSave = el('cfg-tab-save');
    if (cfgSave) cfgSave.style.display = tabName === 'config' ? '' : 'none';
    if (tabName === 'logs') _fetchModalLogs();
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

  function _fetchModalLogs() {
    var pre = el('modal-logs-pre');
    var tailSel = el('modal-logs-tail');
    if (!pre || !_currentAppId) return;
    pre.textContent = 'Loading…';
    var tail = tailSel ? parseInt(tailSel.value, 10) : 100;
    P.getAppLogs(_currentAppId, tail, 'time').then(function (d) {
      var lines = (d && d.lines) ? d.lines : [];
      pre.textContent = lines.map(function (l) {
        return (l.ts ? l.ts + ' ' : '') + (l.pod ? '[' + l.pod + '] ' : '') + (l.message || '');
      }).join('\n') || '(no logs)';
    }).catch(function (err) { pre.textContent = 'Error: ' + (err.message || 'failed'); });
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
        row.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-bottom:0.3rem;';
        var keyIn = document.createElement('input');
        keyIn.type = 'text'; keyIn.value = pair.k; keyIn.readOnly = readOnly;
        keyIn.style.flex = '1'; keyIn.style.fontSize = '0.78rem';
        keyIn.dataset.idx = idx; keyIn.dataset.role = 'cfg-key';
        var valIn = document.createElement('input');
        valIn.type = isSecret ? 'password' : 'text';
        valIn.value = pair.v; valIn.readOnly = readOnly;
        valIn.style.flex = '2'; valIn.style.fontSize = '0.78rem';
        valIn.dataset.idx = idx; valIn.dataset.role = 'cfg-val';
        row.appendChild(keyIn); row.appendChild(valIn);
        if (isSecret) row.appendChild(_makeEyeBtn(valIn));
        if (!readOnly) {
          var del = document.createElement('button');
          del.type = 'button'; del.className = 'btn-icon btn-icon-danger';
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
        addRow.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-top:0.25rem;';
        var newKey = document.createElement('input');
        newKey.type = 'text'; newKey.placeholder = 'new-key'; newKey.style.flex = '1'; newKey.style.fontSize = '0.78rem';
        newKey.dataset.role = 'cfg-pending-key';
        var newVal = document.createElement('input');
        newVal.type = isSecret ? 'password' : 'text';
        newVal.placeholder = 'value'; newVal.style.flex = '2'; newVal.style.fontSize = '0.78rem';
        newVal.dataset.role = 'cfg-pending-val';
        if (isSecret) addRow.appendChild(newKey), addRow.appendChild(newVal), addRow.appendChild(_makeEyeBtn(newVal));
        else addRow.appendChild(newKey), addRow.appendChild(newVal);
        var addBtn = document.createElement('button');
        addBtn.type = 'button'; addBtn.className = 'btn-sm btn-outline'; addBtn.style.flexShrink = '0';
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
    }

    // Register a collector function so the tab-level save button can harvest all editors
    _kvEditors[kind + '/' + volName] = {
      appId: appId, kind: kind, volName: volName,
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

  function _initAddKvEditor(wrap, isSecret) {
    function addRow() {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-bottom:0.3rem;';
      var keyIn = document.createElement('input');
      keyIn.type = 'text'; keyIn.placeholder = 'key'; keyIn.style.flex = '1'; keyIn.style.fontSize = '0.78rem';
      keyIn.dataset.role = 'add-kv-key';
      var valIn = document.createElement('input');
      valIn.type = isSecret ? 'password' : 'text';
      valIn.placeholder = 'value'; valIn.style.flex = '2'; valIn.style.fontSize = '0.78rem';
      valIn.dataset.role = 'add-kv-val';
      row.appendChild(keyIn); row.appendChild(valIn);
      if (isSecret) row.appendChild(_makeEyeBtn(valIn));
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'btn-icon btn-icon-danger';
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
    P.getAppDetail(appId).then(function (d) {
      var app = d.app || {};
      // Use CR spec when available (fullest representation including targetPeer etc.)
      var crSpec = d.cr && d.cr.spec;
      var spec = crSpec || (d.k8s && d.k8s.spec) || app.spec || {};
      var isSubmitted = !!app.target_peer;

      // ── Overview tab ──────────────────────────────────────────
      var overviewHtml =
        '<div class="detail-grid">' +
          '<div class="detail-block"><h4>App Info</h4>' +
            '<div class="detail-row"><span class="label">ID</span><span class="mono">' + _esc(app.id) + '</span></div>' +
            '<div class="detail-row"><span class="label">Status</span>' + statusBadge(app.status) + '</div>' +
            '<div class="detail-row"><span class="label">' + (isSubmitted ? 'Running on' : 'From peer') + '</span><span>' + _esc(app.target_peer || app.source_peer || '—') + '</span></div>' +
            '<div class="detail-row"><span class="label">Updated</span><span>' + timeAgo(app.updated_at) + '</span></div>' +
          '</div>' +
          '<div class="detail-block"><h4>Spec</h4>' +
            '<div class="detail-row"><span class="label">Image</span><span class="mono">' + _esc(spec.image || '—') + '</span></div>' +
            '<div class="detail-row"><span class="label">Replicas</span><span>' + (spec.replicas || 1) + '</span></div>' +
            (spec.ports && spec.ports.length ? '<div class="detail-row"><span class="label">Ports</span><span>' + spec.ports.map(function (p) { return (p.name ? _esc(p.name) + ':' : '') + p.port; }).join(', ') + '</span></div>' : '') +
            ((spec.configMaps || []).length ? '<div class="detail-row"><span class="label">ConfigMaps</span><span>' + spec.configMaps.map(function (c) { return _esc(c.name); }).join(', ') + '</span></div>' : '') +
            ((spec.secrets || []).length ? '<div class="detail-row"><span class="label">Secrets</span><span>' + spec.secrets.map(function (s) { return _esc(s.name); }).join(', ') + '</span></div>' : '') +
            ((spec.pvcs || []).length ? '<div class="detail-row"><span class="label">PVCs</span><span>' + spec.pvcs.map(function (p) { return _esc(p.name) + ' (' + _esc(p.storage) + ')'; }).join(', ') + '</span></div>' : '') +
          '</div>' +
        '</div>';
      if ((spec.ports || []).length) {
        overviewHtml += '<div class="detail-block" style="margin-bottom:0.85rem;"><h4>Proxy URLs</h4>';
        (spec.ports || []).forEach(function (p) {
          var portNum = p.port || 80;
          var proxyUrl = window.location.origin + P.API_BASE + '/remoteapp/' + app.id + '/proxy/' + portNum;
          overviewHtml += '<div class="detail-row"><span class="label">' + portNum + (p.name ? ' (' + _esc(p.name) + ')' : '') + '</span><span class="mono" style="font-size:0.72rem;word-break:break-all;">' + _esc(proxyUrl) + '</span></div>';
        });
        overviewHtml += '</div>';
      }

      // ── Logs tab ──────────────────────────────────────────────
      var logsHtml =
        '<div class="modal-logs-toolbar">' +
          '<span class="text-sm text-muted">Tail:</span>' +
          '<select id="modal-logs-tail" class="logs-tail-select" style="min-height:28px;padding:0.2rem 1.8rem 0.2rem 0.5rem;font-size:0.78rem;">' +
            '<option value="50">50</option><option value="100" selected>100</option><option value="200">200</option>' +
          '</select>' +
          '<button type="button" class="btn-sm" id="modal-logs-refresh">Refresh</button>' +
        '</div>' +
        '<div class="modal-logs-viewer"><pre id="modal-logs-pre" class="logs-content">Loading…</pre></div>';

      // ── Config tab ────────────────────────────────────────────
      var configHtml = _buildConfigTab(spec, isSubmitted);

      // ── Spec tab ──────────────────────────────────────────────
      var specYaml = d.spec_yaml || _specToYaml(spec);
      var specLineCount = specYaml ? specYaml.split('\n').length : 1;
      var specEditorPx = Math.max(180, Math.min(480, specLineCount * 19 + 16));
      var editHtml = isSubmitted
        ? '<p class="text-sm text-muted" style="margin-bottom:0.75rem;">Edit the YAML spec and save to update the running deployment.</p>' +
          '<div class="monaco-editor-wrap" id="modal-spec-editor-wrap">' +
            '<div id="modal-spec-editor-host" class="monaco-editor-host" style="height:' + specEditorPx + 'px;" aria-label="YAML spec editor"></div>' +
            '<textarea id="modal-spec-textarea" class="monaco-fallback-textarea modal-spec-editor" rows="' + specLineCount + '" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-spec-yaml="' + _esc(specYaml) + '">' + _esc(specYaml) + '</textarea>' +
          '</div>' +
          '<div class="flex-end mt1"><button type="button" class="btn-sm" id="modal-spec-save">Save &amp; apply</button></div>'
        : '<p class="text-sm text-muted">Editing is only available for workloads you submitted.</p>';

      // ── Assemble tabs ─────────────────────────────────────────
      var podReady = app.status === 'Running' || app.status === 'Ready';
      var configTabDisabled = !podReady;
      var tabsHtml =
        '<div class="modal-tabs">' +
          '<button type="button" class="modal-tab active" data-tab="overview">Overview</button>' +
          '<button type="button" class="modal-tab" data-tab="logs">Logs</button>' +
          (isSubmitted ? '<button type="button" class="modal-tab' + (configTabDisabled ? ' modal-tab-disabled' : '') + '" data-tab="config"' + (configTabDisabled ? ' disabled title="Available when pod is Running"' : '') + '>Config</button>' : '') +
          (isSubmitted ? '<button type="button" class="modal-tab" data-tab="edit">Spec</button>' : '') +
        '</div>' +
        '<div class="modal-tab-panel active" data-panel="overview">' + overviewHtml + '</div>' +
        '<div class="modal-tab-panel" data-panel="logs">' + logsHtml + '</div>' +
        (isSubmitted ? '<div class="modal-tab-panel" data-panel="config"><div id="cfg-panel-body"' + (configTabDisabled ? ' style="opacity:0.4;pointer-events:none;"' : '') + '>' + configHtml + '</div></div>' : '') +
        (isSubmitted ? '<div class="modal-tab-panel" data-panel="edit">' + editHtml + '</div>' : '');

      var actionsHtml = '<div class="detail-actions">' +
        '<button type="button" class="btn-sm btn-danger app-modal-delete-btn">Delete workload</button>' +
        (isSubmitted ? '<button type="button" class="btn-sm" id="cfg-tab-save" style="display:none;margin-left:auto;">Save &amp; restart</button>' : '') +
        '</div>';

      body.innerHTML = tabsHtml + actionsHtml;
      if (initialTab) _showModalTab(initialTab);
      initCustomDropdowns();
      initNumSpinners();

      // Wire up config KV editors after DOM is built
      (spec.configMaps || []).forEach(function (cm, i) {
        _buildKvEditor('cfg-cm-' + i, app.id, 'configmap', cm.name, !isSubmitted);
      });
      (spec.secrets || []).forEach(function (sec, i) {
        _buildKvEditor('cfg-sec-' + i, app.id, 'secret', sec.name, !isSubmitted);
      });

      // Save & restart — patches existing KV editors + applies any open add-forms
      var cfgSaveBtn = el('cfg-tab-save');
      if (cfgSaveBtn) {
        cfgSaveBtn.addEventListener('click', function () {
          cfgSaveBtn.disabled = true; cfgSaveBtn.textContent = 'Saving…';

          // Check for open add-forms (new CM/secret/PVC entries)
          var newSpec = JSON.parse(JSON.stringify(app.spec || {}));
          var hasNewEntries = false;
          ['configmap', 'secret'].forEach(function (kind) {
            var bodyEl = el('add-' + kind + '-body');
            if (!bodyEl || bodyEl.hidden) return;
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
          var pvcBodyEl = el('add-pvc-body');
          if (pvcBodyEl && !pvcBodyEl.hidden) {
            var pvcName = (el('add-pvc-name') || {}).value || '';
            var pvcMount = (el('add-pvc-mount') || {}).value || '';
            var pvcStorage = (el('add-pvc-storage') || {}).value || '1Gi';
            var pvcMode = (el('add-pvc-mode') || {}).value || 'ReadWriteOnce';
            if (pvcName.trim() && pvcMount.trim()) {
              hasNewEntries = true;
              newSpec.pvcs = (newSpec.pvcs || []).concat([{ name: pvcName.trim(), mountPath: pvcMount.trim(), storage: pvcStorage.trim(), accessMode: pvcMode }]);
            }
          }

          // KV patches for existing CMs/secrets
          var doKvPatches = function () {
            var patches = Object.values(_kvEditors).map(function (ed) {
              var data = ed.collect();
              var url = P.API_BASE + '/remoteapp/' + ed.appId + '/config/' + ed.kind + '/' + encodeURIComponent(ed.volName);
              return fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: data }) })
                .then(function (r) { return r.json(); })
                .then(function (res) { if (!res.ok) throw new Error(res.error || 'patch failed'); });
            });
            return Promise.all(patches);
          };

          // New entries go through spec update; existing KV edits go direct via PATCH
          var work = hasNewEntries
            ? P.updateAppSpec(app.id, _specToYaml(newSpec))
            : doKvPatches();

          work.then(function () {
            toast('Saved — rollout restarting', 'ok');
            closeAppModal();
          }).catch(function (err) {
            toast('Error: ' + err.message, 'error');
            cfgSaveBtn.disabled = false; cfgSaveBtn.textContent = 'Save & restart';
          });
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

      // Tab click
      body.querySelectorAll('.modal-tab').forEach(function (t) {
        t.addEventListener('click', function () {
          if (t.disabled || t.classList.contains('modal-tab-disabled')) return;
          _showModalTab(t.dataset.tab);
        });
      });

      // Logs refresh
      var logsRefreshBtn = el('modal-logs-refresh');
      if (logsRefreshBtn) logsRefreshBtn.addEventListener('click', _fetchModalLogs);
      var logsTailSel = el('modal-logs-tail');
      if (logsTailSel) logsTailSel.addEventListener('change', _fetchModalLogs);

      // Spec save
      var specSaveBtn = el('modal-spec-save');
      if (specSaveBtn) {
        specSaveBtn.addEventListener('click', function () {
          var yamlStr = window.PorpulsionVscodeEditor
            ? window.PorpulsionVscodeEditor.getModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea')
            : (el('modal-spec-textarea') || {}).value || '';
          if (!yamlStr.trim()) { toast('Spec cannot be empty', 'error'); return; }
          if (yamlStr.indexOf('image:') === -1) { toast('Spec must include an image field', 'error'); return; }
          specSaveBtn.disabled = true;
          specSaveBtn.textContent = 'Saving…';
          P.updateAppSpec(app.id, yamlStr).then(function () {
            toast('Spec updated', 'ok');
            specSaveBtn.disabled = false;
            specSaveBtn.textContent = 'Save & apply';
            refresh();
          }).catch(function (err) {
            toast('Error: ' + err.message, 'error');
            specSaveBtn.disabled = false;
            specSaveBtn.textContent = 'Save & apply';
          });
        });
      }

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
    var modal = el('app-modal');
    if (modal) modal.classList.remove('open');
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
    document.querySelectorAll('select:not(.custom-dd-init):not(.logs-tail-select)').forEach(function (sel) {
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
        var url = ((el('setting-registry-api-url') || {}).value || '').trim();
        regSaveBtn.disabled = true; regSaveBtn.textContent = 'Saving…';
        P.updateSettings({ registry_api_url: url })
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
        };
        P.updateSettings(payload).then(function () { toast('Quotas saved', 'ok'); }).catch(function (err) { toast(err.message, 'error'); });
      });
    }

    var pvcQuotasSaveBtn = el('setting-pvc-quotas-save');
    if (pvcQuotasSaveBtn) {
      pvcQuotasSaveBtn.addEventListener('click', function () {
        var payload = {
          max_pvc_storage_per_pvc_gb: parseInt((el('setting-max-pvc-per') || {}).value || '0', 10) || 0,
          max_pvc_storage_total_gb:   parseInt((el('setting-max-pvc-total') || {}).value || '0', 10) || 0,
        };
        P.updateSettings(payload).then(function () { toast('PVC quotas saved', 'ok'); }).catch(function (err) { toast(err.message, 'error'); });
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
