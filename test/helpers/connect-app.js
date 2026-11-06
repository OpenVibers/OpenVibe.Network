'use strict';
/**
 * A stand-in for an app's API, for the Connect tests: https on loopback, with a scripted answer.
 *
 * The gateway never calls an address a test chose: it calls the app's own host, through the egress
 * guard. The test injects the resolver (lookup) and the TLS options, so the guard is exercised for
 * real (the host name is checked, the redirect is checked, the literal is checked) while the socket
 * lands on the test's own server.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const KEY = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'connect-key.pem'));
const CERT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'connect-cert.pem'));

/** Starts the stand-in on a free port. → { port, host, options, stop } */
async function startApp(handler) {
    const server = https.createServer({ key: KEY, cert: CERT }, handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        port,
        // A public-looking host name: the guard refuses *.local and names without a dot.
        host: 'api.test.example:' + port,
        // The resolver the guard uses: the app's host name always lands on this server.
        options: {
            lookup: (hostname, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
            isAllowed: () => true,
            tls: { rejectUnauthorized: false },
        },
        stop: () => new Promise((resolve) => server.close(resolve)),
    };
}

/** The JSON answer of one request, as a string. */
const json = (status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, headers: { 'content-type': 'application/json', ...headers }, body: text };
};

module.exports = { startApp, json };
