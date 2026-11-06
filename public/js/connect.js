/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — Connect (Compute plan E7): the Apps page.

   The catalogue, the walkthrough, the paste box, the test result, the connected
   list with the grants per caller, the log and the approvals. Everything here
   is a small, quiet piece of the page: the page itself is the kit's own markup.

   Classic script, no modules. The token is the person's own (the same one the
   account hub uses): the cookie first, then localStorage.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var API = '/api/v1/connect';

    function token() {
        try {
            var m = document.cookie.match(/(?:^|; )ov_token=([^;]*)/);
            if (m) return decodeURIComponent(m[1]);
        } catch (e) { /* no cookie */ }
        try { return localStorage.getItem('ov_token') || null; } catch (e) { return null; }
    }

    function api(path, opts) {
        opts = opts || {};
        var headers = { 'Content-Type': 'application/json' };
        var t = token();
        if (t) headers.Authorization = 'Bearer ' + t;
        return fetch(API + path, {
            method: opts.method || 'GET',
            headers: headers,
            credentials: 'include',
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        }).then(function (res) {
            return res.text().then(function (text) {
                var data = null;
                try { data = text ? JSON.parse(text) : null; } catch (e) { data = { error: 'connect.failed', detail: text.slice(0, 200) }; }
                if (!res.ok) {
                    var err = new Error((data && (data.detail || data.error)) || ('The call failed (' + res.status + ')'));
                    err.status = res.status;
                    err.code = data && data.error;
                    throw err;
                }
                return data;
            });
        });
    }

    function el(tag, attrs, kids) {
        var n = document.createElement(tag);
        attrs = attrs || {};
        Object.keys(attrs).forEach(function (k) {
            var v = attrs[k];
            if (v === null || v === undefined) return;
            if (k === 'text') n.textContent = v;
            else if (k === 'class') n.className = v;
            else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
            else n.setAttribute(k, v);
        });
        (kids || []).forEach(function (kid) { if (kid) n.append(kid); });
        return n;
    }

    function say(box, text, kind) {
        if (!box) return;
        box.hidden = false;
        box.textContent = text;
        box.className = 'ovk-result' + (kind ? ' ovk-result--' + kind : '');
    }

    // ── The catalogue: search over the folds ────────────────────
    function wireSearch() {
        var form = document.querySelector('.ovk-find');
        if (!form) return;
        var input = form.querySelector('input');
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            filter(input ? input.value : '');
        });
        if (input) input.addEventListener('input', function () { filter(input.value); });
    }

    function filter(q) {
        var needle = String(q || '').trim().toLowerCase();
        document.querySelectorAll('.ovk-connect-grid > details').forEach(function (d) {
            var text = (d.textContent || '').toLowerCase();
            var title = (d.querySelector('summary') || {}).textContent || '';
            d.hidden = !!needle && text.indexOf(needle) === -1 && title.toLowerCase().indexOf(needle) === -1;
        });
    }

    // ── The paste box, the test call and the connect ───────────
    function wireConnect() {
        document.querySelectorAll('[data-ovk-connect]').forEach(function (form) {
            var app = form.getAttribute('data-ovk-connect');
            var box = form.querySelector('[data-ovk-result]');
            var values = function () {
                var out = {};
                form.querySelectorAll('[data-ovk-field]').forEach(function (input) {
                    out[input.getAttribute('data-ovk-field')] = input.value;
                });
                return out;
            };
            var test = form.querySelector('[data-ovk-test]');
            var save = form.querySelector('[data-ovk-save]');
            if (test) test.addEventListener('click', function () {
                say(box, 'Testing…');
                api('/apps/' + encodeURIComponent(app) + '/test', { method: 'POST', body: { credential: values() } })
                    .then(function (out) {
                        say(box, 'It works. ' + (out.summary || '') + ' Nothing is stored until you press Connect.', 'ok');
                    })
                    .catch(function (e) { say(box, 'The credential was refused: ' + e.message, 'bad'); });
            });
            if (save) save.addEventListener('click', function () {
                say(box, 'Testing…');
                api('/apps/' + encodeURIComponent(app) + '/connect', { method: 'POST', body: { credential: values() } })
                    .then(function () { window.location.reload(); })
                    .catch(function (e) { say(box, 'The credential was refused: ' + e.message, 'bad'); });
            });
        });
    }

    // ── Revoke a credential or a caller ─────────────────────────
    function wireRevoke() {
        document.querySelectorAll('[data-ovk-revoke]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var app = btn.getAttribute('data-ovk-revoke');
                var label = btn.getAttribute('data-ovk-label') || 'default';
                if (!window.confirm('Revoke the credential for ' + app + '? The key is gone from OpenVibe.')) return;
                api('/credentials/' + encodeURIComponent(app) + '/' + encodeURIComponent(label), { method: 'DELETE' })
                    .then(function () { window.location.reload(); })
                    .catch(function (e) { window.alert(e.message); });
            });
        });
        document.querySelectorAll('[data-ovk-revoke-caller]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-ovk-revoke-caller');
                if (!window.confirm('Revoke this caller? Its grants go with it.')) return;
                api('/callers/' + encodeURIComponent(id), { method: 'DELETE' })
                    .then(function () { window.location.reload(); })
                    .catch(function (e) { window.alert(e.message); });
            });
        });
    }

    // ── A key for one caller of the person's own ───────────────
    function wireMakeKey() {
        var form = document.querySelector('[data-ovk-make-key]');
        if (!form) return;
        var box = form.querySelector('[data-ovk-key]');
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var name = (form.querySelector('input[name=name]') || {}).value || '';
            if (!name.trim()) { say(box, 'Give the caller a name.', 'bad'); return; }
            api('/callers', { method: 'POST', body: { name: name.trim() } })
                .then(function (out) {
                    say(box, 'Here is your key — it is shown once: ' + out.key, 'ok');
                    form.querySelector('input[name=name]').value = '';
                    if (window.OpenVibeKit && OpenVibeKit.enhance) OpenVibeKit.enhance(document.body);
                })
                .catch(function (e) { say(box, e.message, 'bad'); });
        });
    }

    // ── The grants: one caller, one app ─────────────────────────
    function loadGrants() {
        var panel = document.querySelector('[data-ovk-grants-panel]');
        if (!panel) return;
        Promise.all([api('/callers'), api('/credentials')]).then(function (res) {
            var callers = (res[0] && res[0].callers) || [];
            var creds = (res[1] && res[1].credentials) || [];
            var apps = [];
            creds.forEach(function (c) { if (apps.indexOf(c.app) === -1) apps.push(c.app); });
            panel.replaceChildren();
            if (!apps.length) { panel.append(el('p', { class: 'ovk-note', text: 'Connect an app first, then give your callers a grant in it.' })); return; }
            var rows = [];
            callers.forEach(function (call) {
                apps.forEach(function (app) {
                    var level = (call.grants || {})[app] || '';
                    var select = el('select', { class: 'ovk-grant-select', 'data-ovk-grant': call.id, 'data-ovk-app': app });
                    [['', 'No access'], ['read', 'Read'], ['write', 'Read and write']].forEach(function (opt) {
                        var o = el('option', { value: opt[0], text: opt[1] });
                        if (opt[0] === level) o.selected = true;
                        select.append(o);
                    });
                    select.addEventListener('change', function () {
                        api('/callers/' + encodeURIComponent(call.id) + '/grants', { method: 'PUT', body: { app: app, level: select.value || null } })
                            .catch(function (e) { window.alert(e.message); });
                    });
                    rows.push(el('div', { class: 'ovk-grant-row' },
                        el('span', { class: 'ovk-grant-who', text: call.name }),
                        el('span', { class: 'ovk-grant-app', text: app }),
                        select));
                });
            });
            if (!rows.length) { panel.append(el('p', { class: 'ovk-note', text: 'No callers yet.' })); return; }
            panel.append(el('div', { class: 'ovk-grants-head' },
                el('span', { text: 'Caller' }), el('span', { text: 'App' }), el('span', { text: 'Grant' })));
            rows.forEach(function (r) { panel.append(r); });
        }).catch(function () { /* the page still works without the panel */ });
    }

    // ── The approvals that wait for the person ─────────────────
    function wireApprovals() {
        document.querySelectorAll('[data-ovk-approval]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-ovk-approval');
                var decision = btn.getAttribute('data-ovk-decision');
                api('/approvals/' + encodeURIComponent(id), { method: 'POST', body: { decision: decision } })
                    .then(function () { window.location.reload(); })
                    .catch(function (e) { window.alert(e.message); });
            });
        });
    }

    /** New approvals can arrive while the page is open: look now and then. */
    function watchApprovals() {
        var section = document.getElementById('ovk-needs-you');
        if (!section) return;
        setInterval(function () {
            api('/approvals?state=pending').then(function (out) {
                var pending = (out && out.approvals) || [];
                var count = section.querySelector('.ovk-count');
                if (count) count.textContent = String(pending.length);
                var list = section.querySelector('.ovk-list');
                if (list && pending.length) {
                    list.replaceChildren.apply(list, pending.map(function (a) {
                        return el('li', { class: 'ovk-row ovk-row--static' },
                            el('span', { class: 'ovk-row-main' },
                                el('span', { class: 'ovk-row-top' }, el('strong', { text: a.summary || a.action })),
                                el('span', { class: 'ovk-row-sub' }, el('span', { text: a.action }))),
                            el('span', { class: 'ovk-row-trail' },
                                el('button', { class: 'ovk-btn ovk-btn--primary ovk-btn--small', type: 'button', text: 'Allow', onclick: function () { decide(a.id, 'approve'); } }),
                                el('button', { class: 'ovk-btn ovk-btn--quiet ovk-btn--small', type: 'button', text: 'Deny', onclick: function () { decide(a.id, 'deny'); } })));
                    }));
                }
            }).catch(function () { /* offline: the page keeps what it has */ });
        }, 5000);
    }

    function decide(id, decision) {
        api('/approvals/' + encodeURIComponent(id), { method: 'POST', body: { decision: decision } })
            .then(function () { window.location.reload(); })
            .catch(function (e) { window.alert(e.message); });
    }

    document.addEventListener('DOMContentLoaded', function () {
        wireSearch();
        wireConnect();
        wireRevoke();
        wireMakeKey();
        wireApprovals();
        loadGrants();
        watchApprovals();
    });
})();
