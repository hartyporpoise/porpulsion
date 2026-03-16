(function () {
  'use strict';

  var hintSchema = {};
  var DEFAULT_DEPLOY_SPEC = 'image: nginx:latest\nreplicas: 1\nports:\n  - port: 80\n    name: http';
  var deploySpecEditor = null;
  var deployEditorInitStarted = false;
  var deployThemeObserver = null;

  function el(id) { return document.getElementById(id); }

  function getDeploySpecTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
  }

  function setDeploySpecValue(nextValue) {
    var yamlEl = el('app-spec-yaml');
    var fallbackEl = el('app-spec-yaml-fallback');
    if (yamlEl) yamlEl.value = nextValue;
    if (fallbackEl) fallbackEl.value = nextValue;
    if (deploySpecEditor) deploySpecEditor.setValue(nextValue);
  }

  function useFallbackEditor(yamlEl, fallbackEl, hostEl) {
    if (!fallbackEl) return;
    fallbackEl.value = yamlEl.value || DEFAULT_DEPLOY_SPEC;
    fallbackEl.style.display = 'block';
    if (hostEl) hostEl.style.display = 'none';
    if (fallbackEl.dataset.porpulsionSyncBound !== 'true') {
      fallbackEl.dataset.porpulsionSyncBound = 'true';
      fallbackEl.addEventListener('input', function () { yamlEl.value = fallbackEl.value; });
    }
  }

  function initDeploySpecEditor() {
    var yamlEl = el('app-spec-yaml');
    var fallbackEl = el('app-spec-yaml-fallback');
    var hostEl = el('app-spec-editor');
    if (!yamlEl || !hostEl) return;

    if (!yamlEl.value.trim()) yamlEl.value = DEFAULT_DEPLOY_SPEC;

    // Already created — just ensure fallback is hidden and host visible
    if (deploySpecEditor) {
      hostEl.style.display = 'block';
      if (fallbackEl) fallbackEl.style.display = 'none';
      return;
    }

    // Already in progress — nothing to do, callback will finish the job
    if (deployEditorInitStarted) return;
    deployEditorInitStarted = true;

    // Show fallback while Monaco loads; keep host hidden until editor is ready
    if (fallbackEl) { fallbackEl.value = yamlEl.value; fallbackEl.style.display = 'block'; }
    hostEl.style.display = 'none';

    // Kick off hints fetch in parallel — don't block editor creation on it
    loadDeployHints('/api/openapi.json').then(function (hints) {
      hintSchema = hints || {};
    }).catch(function () { hintSchema = {}; });

    _ensureMonacoLoaded(function (monaco) {
      deployEditorInitStarted = false;
      if (!monaco) {
        useFallbackEditor(yamlEl, fallbackEl, hostEl);
        return;
      }

      registerYamlHints(monaco);

      // Show host, hide fallback, then create editor so Monaco reads real dimensions
      hostEl.style.display = 'block';
      if (fallbackEl) fallbackEl.style.display = 'none';

      deploySpecEditor = monaco.editor.create(hostEl, {
        value: yamlEl.value || DEFAULT_DEPLOY_SPEC,
        language: 'yaml',
        theme: getDeploySpecTheme(),
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: false,
        quickSuggestions: true,
        quickSuggestionsDelay: 0,
        suggestOnTriggerCharacters: true,
        fixedOverflowWidgets: true,
        overflowWidgetsDomNode: document.body
      });

      deploySpecEditor.addAction({
        id: 'porpulsion.toggleLineComment',
        label: 'Toggle YAML line comment',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
        run: function (editor) { return editor.getAction('editor.action.commentLine').run(); }
      });

      deploySpecEditor.onDidChangeModelContent(function () {
        yamlEl.value = deploySpecEditor.getValue();
      });
      yamlEl.value = deploySpecEditor.getValue();

      if (!deployThemeObserver && window.MutationObserver) {
        deployThemeObserver = new MutationObserver(function () {
          if (window.monaco && deploySpecEditor) window.monaco.editor.setTheme(getDeploySpecTheme());
        });
        deployThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
    });
  }

  function resolveRef(specDoc, schema) {
    var cur = schema;
    while (cur && cur.$ref && cur.$ref.indexOf('#/') === 0) {
      var path = cur.$ref.slice(2).split('/');
      var resolved = specDoc;
      for (var i = 0; i < path.length; i++) resolved = resolved[path[i]];
      cur = resolved;
    }
    return cur;
  }

  function getRemoteAppSpecSchema(specDoc) {
    var paths = specDoc.paths;
    if (!paths) return null;
    var postOp = paths['/remoteapp'] && paths['/remoteapp'].post;
    if (!postOp || !postOp.requestBody || !postOp.requestBody.content) return null;
    var content = postOp.requestBody.content['application/json'] || postOp.requestBody.content[Object.keys(postOp.requestBody.content)[0]];
    if (!content || !content.schema) return null;
    var requestSchema = content.schema;
    var resolvedRequest = resolveRef(specDoc, requestSchema);
    if (!resolvedRequest || !resolvedRequest.properties || !resolvedRequest.properties.spec) return null;
    return resolveRef(specDoc, resolvedRequest.properties.spec);
  }

  function buildHintsFromSpec(specSchema) {
    var hints = {};
    if (!specSchema || !specSchema.properties) return hints;
    var required = specSchema.required || [];
    Object.keys(specSchema.properties).forEach(function (key) {
      var prop = specSchema.properties[key];
      var kind = (prop && prop.type) ? prop.type : 'field';
      var req = required.indexOf(key) !== -1;
      hints[key] = {
        detail: (req ? 'Required ' : 'Optional ') + kind,
        docs: (prop && prop.description) ? prop.description : ('Field `' + key + '`.')
      };
    });
    return hints;
  }

  function loadDeployHints(openApiUrl) {
    return fetch(openApiUrl, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) return null;
      return res.json().then(function (specDoc) {
        var specSchema = getRemoteAppSpecSchema(specDoc);
        return specSchema ? buildHintsFromSpec(specSchema) : {};
      });
    }).catch(function () { return null; });
  }

  function registerYamlHints(monaco) {
    if (!monaco || window.__porpulsionYamlHintsRegistered) return;
    window.__porpulsionYamlHintsRegistered = true;

    monaco.languages.registerCompletionItemProvider('yaml', {
      triggerCharacters: ['\n', ' ', ':'],
      provideCompletionItems: function (model, position) {
        var keySuggestions = Object.keys(hintSchema).map(function (key) {
          return {
            label: key,
            kind: monaco.languages.CompletionItemKind.Property,
            insertText: key + ': ',
            detail: hintSchema[key].detail,
            documentation: { value: hintSchema[key].docs }
          };
        });
        var word = model.getWordUntilPosition(position);
        var range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        };
        return {
          suggestions: keySuggestions.map(function (item) {
            return Object.assign({}, item, { range: range });
          })
        };
      }
    });

    monaco.languages.registerHoverProvider('yaml', {
      provideHover: function (model, position) {
        var word = model.getWordAtPosition(position);
        if (!word || !hintSchema[word.word]) return null;
        var spec = hintSchema[word.word];
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [
            { value: '**' + word.word + '**' },
            { value: spec.docs }
          ]
        };
      }
    });
  }

  // ── Modal spec editor (used in app detail modal Spec tab) ──────
  var _modalSpecEditors = {}; // keyed by hostId

  // Queue of callbacks waiting for Monaco to finish loading
  var _monacoLoadCallbacks = null; // null = not loading; [] = loading in-flight

  function _ensureMonacoLoaded(callback) {
    if (window.monaco) { callback(window.monaco); return; }

    // Already loading — queue up behind it
    if (_monacoLoadCallbacks) { _monacoLoadCallbacks.push(callback); return; }

    _monacoLoadCallbacks = [callback];
    function _resolve(mc) {
      var cbs = _monacoLoadCallbacks;
      _monacoLoadCallbacks = null;
      cbs.forEach(function (cb) { cb(mc); });
    }

    function _doLoad() {
      window.require(['vs/editor/editor.main'], function () {
        _resolve(window.monaco || null);
      }, function () { _resolve(null); });
    }

    if (window.require) {
      // loader.js is already on the page with require.config set in base.html
      _doLoad();
      return;
    }
    // Fallback: loader.js wasn't on the page — inject it
    var s = document.createElement('script');
    s.src = 'https://unpkg.com/monaco-editor@0.52.2/min/vs/loader.js';
    s.onload = function () {
      window.require.config({ paths: { vs: 'https://unpkg.com/monaco-editor@0.52.2/min/vs' } });
      _doLoad();
    };
    s.onerror = function () { _resolve(null); };
    document.head.appendChild(s);
  }

  function initModalSpecEditor(hostId, fallbackId, initialValue, onChange) {
    var hostEl = el(hostId);
    var fallbackEl = el(fallbackId);
    if (!hostEl && !fallbackEl) return;

    // If already created for this host, just update value
    if (_modalSpecEditors[hostId]) {
      _modalSpecEditors[hostId].setValue(initialValue || '');
      return;
    }

    // Show fallback immediately
    if (fallbackEl) { fallbackEl.style.display = 'block'; fallbackEl.value = initialValue || ''; }
    if (hostEl) hostEl.style.display = 'none';

    // Bind fallback onChange
    if (fallbackEl && onChange && !fallbackEl._modalEditorBound) {
      fallbackEl._modalEditorBound = true;
      fallbackEl.addEventListener('input', function () { onChange(fallbackEl.value); });
    }

    _ensureMonacoLoaded(function (monaco) {
      if (!monaco || !hostEl) {
        if (onChange && fallbackEl) fallbackEl.addEventListener('input', function () { onChange(fallbackEl.value); });
        return;
      }
      // Re-check el still in DOM (modal may have been closed)
      if (!document.body.contains(hostEl)) return;

      registerYamlHints(monaco, '/api/openapi.json');
      var theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
      var editor = monaco.editor.create(hostEl, {
        value: initialValue || '',
        language: 'yaml',
        theme: theme,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: false,
        lineNumbers: 'off',
        folding: false,
        glyphMargin: false,
        quickSuggestions: true,
        fixedOverflowWidgets: true,
        overflowWidgetsDomNode: document.body
      });
      _modalSpecEditors[hostId] = editor;
      if (onChange) {
        editor.onDidChangeModelContent(function () { onChange(editor.getValue()); });
      }
      hostEl.style.display = 'block';
      if (fallbackEl) fallbackEl.style.display = 'none';

      // Theme observer
      if (window.MutationObserver) {
        var obs = new MutationObserver(function () {
          if (window.monaco && editor) {
            window.monaco.editor.setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark');
          }
        });
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
    });
  }

  function disposeModalSpecEditor(hostId) {
    if (_modalSpecEditors[hostId]) {
      _modalSpecEditors[hostId].dispose();
      delete _modalSpecEditors[hostId];
    }
  }

  function getModalSpecEditorValue(hostId, fallbackId) {
    if (_modalSpecEditors[hostId]) return _modalSpecEditors[hostId].getValue();
    var fallbackEl = el(fallbackId);
    return fallbackEl ? fallbackEl.value : '';
  }

  function setModalSpecEditorValue(hostId, fallbackId, value) {
    if (_modalSpecEditors[hostId]) {
      _modalSpecEditors[hostId].setValue(value);
    } else {
      var fallbackEl = el(fallbackId);
      if (fallbackEl) { fallbackEl.value = value; fallbackEl.dispatchEvent(new Event('input', { bubbles: true })); }
    }
  }

  function getDeploySpecValue() {
    if (deploySpecEditor) return deploySpecEditor.getValue();
    var yamlEl = el('app-spec-yaml');
    var fallbackEl = el('app-spec-yaml-fallback');
    if (yamlEl && yamlEl.value.trim()) return yamlEl.value;
    if (fallbackEl && fallbackEl.value.trim()) return fallbackEl.value;
    return '';
  }

  window.PorpulsionVscodeEditor = {
    initDeploySpecEditor: initDeploySpecEditor,
    setDeploySpecValue: setDeploySpecValue,
    getDeploySpecValue: getDeploySpecValue,
    layoutDeployEditor: function () {
      var hostEl = el('app-spec-editor');
      if (deploySpecEditor && hostEl) {
        deploySpecEditor.layout({ width: hostEl.offsetWidth, height: hostEl.offsetHeight });
      }
    },
    getDefaultDeploySpec: function () { return DEFAULT_DEPLOY_SPEC; },
    registerYamlHints: registerYamlHints,
    initModalSpecEditor: initModalSpecEditor,
    disposeModalSpecEditor: disposeModalSpecEditor,
    getModalSpecEditorValue: getModalSpecEditorValue,
    setModalSpecEditorValue: setModalSpecEditorValue
  };
})();
