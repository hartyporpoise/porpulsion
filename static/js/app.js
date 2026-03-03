/**
 * Porpulsion dashboard — toast, theme, DOM helpers.
 * Depends on window.PorpulsionApi (api.js). Builds window.Porpulsion = API + UI helpers.
 */
(function () {
  'use strict';

  var api = window.PorpulsionApi;
  if (!api) throw new Error('Porpulsion app.js requires api.js to be loaded first.');

  function toast(msg, type) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'show' + (type === 'error' ? ' error' : type === 'ok' ? ' ok' : type === 'warn' ? ' warn' : '');
    clearTimeout(el._toastTimer);
    el._toastTimer = setTimeout(function () { el.className = ''; }, 3000);
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function statusBadge(status) {
    var s = (status || 'unknown').toLowerCase();
    var cls = 'badge-pending';
    var dot = '';
    if (s === 'ready') { cls = 'badge-ready'; dot = '<span class="badge-dot"></span>'; }
    else if (s === 'running') { cls = 'badge-running'; }
    else if (s === 'creating') { cls = 'badge-creating'; }
    else if (s === 'updating') { cls = 'badge-creating'; }
    else if (s.indexOf('fail') === 0) { cls = 'badge-failed'; }
    else if (s === 'timeout') { cls = 'badge-timeout'; }
    else if (s === 'approved') { cls = 'badge-approved'; }
    else if (s === 'rejected') { cls = 'badge-rejected'; }
    else if (s === 'deleted') { cls = 'badge-deleted'; }
    else if (s === 'connected') { cls = 'badge-mtls'; dot = '<span class="badge-dot"></span>'; }
    return '<span class="badge ' + cls + '">' + dot + (status || 'unknown') + '</span>';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    return Math.floor(diff / 3600) + 'h ago';
  }

  function setSecret(id, value) {
    var el = document.getElementById(id);
    if (!el) return;
    el.dataset.value = value;
    if (!el.classList.contains('masked')) el.textContent = value || '—';
  }

  function copyText(elemId, btn) {
    var el = document.getElementById(elemId);
    if (!el) return;
    var text = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : el.textContent;
    navigator.clipboard.writeText(text.trim()).then(function () {
      var orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = orig; }, 1500);
    }).catch(function () { toast('Copy failed', 'error'); });
  }

  var eyeSvg = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1 10s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="10" cy="10" r="2.5"/></svg>';
  var eyeHideSvg = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1 10s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="10" cy="10" r="2.5"/><line x1="2" y1="2" x2="18" y2="18"/></svg>';

  function toggleSecret(id, btn) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.classList.contains('masked')) {
      el.classList.remove('masked');
      el.textContent = el.dataset.value || '—';
      btn.innerHTML = eyeHideSvg;
    } else {
      el.classList.add('masked');
      el.textContent = '••••••••••••••••••••••••••••••••';
      btn.innerHTML = eyeSvg;
    }
  }

  function copySecret(id, btn) {
    var el = document.getElementById(id);
    if (!el) return;
    var val = el.dataset.value || el.textContent;
    navigator.clipboard.writeText(val).then(function () {
      var orig = btn.textContent;
      btn.textContent = '✓';
      setTimeout(function () { btn.textContent = orig; }, 1200);
    }).catch(function () { toast('Copy failed', 'error'); });
  }

  // Single global: API + UI helpers (backwards compatible)
  window.Porpulsion = Object.assign({}, api, {
    toast: toast,
    esc: esc,
    statusBadge: statusBadge,
    timeAgo: timeAgo,
    setSecret: setSecret,
    copyText: copyText,
    toggleSecret: toggleSecret,
    copySecret: copySecret,
  });
})();
