'use strict';
// panels.js: one open at a time, nested panels do not close their container, Escape closes all.
const assert = require('assert'); const vm = require('vm'); const fs = require('fs'); const path = require('path');
const observers = []; const listeners = {};
const mk = (name, parent) => { const cls = new Set(); const el = { name, parent, isConnected: true, scrollTop: 5,
    classList: { contains: c => cls.has(c), add: c => { cls.add(c); fire(el); }, remove: c => { cls.delete(c); fire(el); }, toggle: (c, f) => { (f === undefined ? !cls.has(c) : f) ? cls.add(c) : cls.delete(c); fire(el); } },
    contains: (o) => { for (let x = o; x; x = x.parent) if (x === el) return true; return false; } }; return el; };
const fire = (el) => observers.filter(o => o.el === el).forEach(o => o.cb());
const body = mk('body');
const ctx = vm.createContext({ console, MutationObserver: function (cb) { this.observe = (el) => observers.push({ el, cb }); },
    document: { body, addEventListener: (t, f) => { listeners[t] = f; } } });
ctx.window = ctx; ctx.globalThis = ctx; ctx.addEventListener = () => {};
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'panels.js'), 'utf8'), ctx);
const P = ctx.OpenVibePanels;
const menu = mk('menu'), drawer = mk('drawer'), sub = mk('sub', drawer);
P.register({ el: menu, openClass: 'show' }); P.register({ el: drawer, openClass: 'show' }); P.register({ el: sub, openClass: 'open' });
menu.classList.add('show'); assert.ok(body.classList.contains('ov-panel-open')); assert.equal(menu.scrollTop, 0, 'opens scrolled to the top');
drawer.classList.add('show'); assert.ok(!menu.classList.contains('show'), 'opening one closes the other');
sub.classList.add('open'); assert.ok(drawer.classList.contains('show'), 'a nested panel keeps its container open');
listeners.keydown({ key: 'Escape' }); assert.ok(!drawer.classList.contains('show') && !sub.classList.contains('open') && !body.classList.contains('ov-panel-open'), 'Escape closes everything');
console.log('panels: all checks passed');
