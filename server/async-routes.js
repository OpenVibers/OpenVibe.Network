'use strict';

// ═══════════════════════════════════════════════════════════════
// Async route handlers on Express 4 (plan T2).
//
// Every query is async on PostgreSQL, so most handlers are async functions. Express 4 ignores what a
// handler returns: a rejected promise (a failed query, say) was an unhandled rejection, which ends a
// Node 22 process, and the request hung. With this installed a rejection goes to next(err), exactly
// where a synchronous throw went before (Express's own error handling answers 500), as Express 5 does.
// Installed once, before the first request, by server/index.js.
// ═══════════════════════════════════════════════════════════════

const Layer = require('express/lib/router/layer');

const INSTALLED = Symbol.for('openvibe.network.async-routes');

function forward(next) {
    return (err) => next(err || new Error('the route handler rejected without a reason'));
}

function install() {
    if (Layer.prototype[INSTALLED]) return;
    Layer.prototype[INSTALLED] = true;

    Layer.prototype.handle_request = function handle(req, res, next) {
        const fn = this.handle;
        if (fn.length > 3) return next();   // an error handler: not for a request
        try {
            const r = fn(req, res, next);
            if (r && typeof r.then === 'function') r.then(undefined, forward(next));
        } catch (err) {
            next(err);
        }
    };

    Layer.prototype.handle_error = function handleError(error, req, res, next) {
        const fn = this.handle;
        if (fn.length !== 4) return next(error);   // not an error handler
        try {
            const r = fn(error, req, res, next);
            if (r && typeof r.then === 'function') r.then(undefined, forward(next));
        } catch (err) {
            next(err);
        }
    };
}

install();

module.exports = { install };
