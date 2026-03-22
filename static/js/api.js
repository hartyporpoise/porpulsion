/**
 * Porpulsion API client — base URL, fetch helpers, and all /api/* endpoints.
 * Load before app.js. Exposes window.PorpulsionApi for use by app.js and pages.
 */
(function () {
  'use strict';

  var API_BASE = '/api';

  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    });
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || r.statusText);
        return d;
      });
    });
  }

  function del(url) {
    return fetch(url, { method: 'DELETE' }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || r.statusText);
        return d;
      });
    });
  }

  function putJson(url, body) {
    return fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || r.statusText);
        return d;
      });
    });
  }

  window.PorpulsionApi = {
    API_BASE: API_BASE,
    getJson: getJson,
    postJson: postJson,
    del: del,
    putJson: putJson,

    getPeers: function () { return getJson(API_BASE + '/peers'); },
    getRemoteApps: function () { return getJson(API_BASE + '/remoteapps'); },
    getPendingApproval: function () { return getJson(API_BASE + '/remoteapp/pending-approval'); },
    getSettings: function () { return getJson(API_BASE + '/settings'); },
    getInvite: function () { return getJson(API_BASE + '/invite'); },
    getProxyDnsCheck: function () { return getJson(API_BASE + '/proxy-dns-check'); },

    connectPeer: function (body) { return postJson(API_BASE + '/peers/connect', body); },
    createRemoteApp: function (body) { return postJson(API_BASE + '/remoteapp', body); },
    approveApp: function (id) { return postJson(API_BASE + '/remoteapp/' + id + '/approve'); },
    rejectApp: function (id) { return postJson(API_BASE + '/remoteapp/' + id + '/reject'); },
    removePeer: function (name) { return del(API_BASE + '/peers/' + encodeURIComponent(name)); },
    deleteApp: function (id) { return del(API_BASE + '/remoteapp/' + id); },
    getAppDetail: function (id) { return getJson(API_BASE + '/remoteapp/' + id + '/detail'); },
    scaleApp: function (id, replicas) { return postJson(API_BASE + '/remoteapp/' + id + '/scale', { replicas: replicas }); },
    updateAppSpec: function (id, specYaml) { return putJson(API_BASE + '/remoteapp/' + id + '/spec', { spec_yaml: specYaml }); },
    updateSettings: function (data) { return postJson(API_BASE + '/settings', data); },

    getNotifications: function () { return getJson(API_BASE + '/notifications'); },
    ackNotification: function (id) { return postJson(API_BASE + '/notifications/' + id + '/ack', {}); },
    deleteNotification: function (id) { return del(API_BASE + '/notifications/' + id); },
    clearNotifications: function () { return del(API_BASE + '/notifications'); },

    getLogs: function (tail) { return getJson(API_BASE + '/logs' + (tail ? '?tail=' + tail : '')); },
    getAppLogs: function (appId, tail, order) {
      return getJson(API_BASE + '/remoteapp/' + encodeURIComponent(appId) + '/logs?tail=' + (tail || 200) + '&order=' + (order || 'pod'));
    },
    restartApp: function (id) { return postJson(API_BASE + '/remoteapp/' + encodeURIComponent(id) + '/restart', {}); },
    getAppPods: function (appId) {
      return getJson(API_BASE + '/remoteapp/' + encodeURIComponent(appId) + '/pods');
    },
    execInPod: function (appId, pod, command) {
      return postJson(API_BASE + '/remoteapp/' + encodeURIComponent(appId) + '/exec', { pod: pod, command: command });
    },
    proxyUrl: function (appId, port) {
      return window.location.origin + API_BASE + '/remoteapp/' + appId + '/proxy/' + port;
    },
  };
})();
