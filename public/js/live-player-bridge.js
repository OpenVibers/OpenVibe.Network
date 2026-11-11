'use strict';
(() => {
    const from = new URLSearchParams(location.search).get('from');
    const frame = document.getElementById('player');
    const liveOrigin = 'https://openvibe.live';
    if (!from || !frame || parent === window) return;
    let loaded = false;
    const pending = [];
    frame.addEventListener('load', () => {
        loaded = true;
        for (const cmd of pending.splice(0)) frame.contentWindow.postMessage({ type: 'ov-embed', cmd }, liveOrigin);
    });
    addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.type !== 'ov-embed') return;
        if (event.source === parent && event.origin === from) {
            if (!['mute', 'unmute', 'play', 'pause'].includes(data.cmd)) return;
            if (loaded) frame.contentWindow.postMessage({ type: 'ov-embed', cmd: data.cmd }, liveOrigin);
            else pending.push(data.cmd);
        } else if (event.source === frame.contentWindow && event.origin === liveOrigin && data.event === 'state') {
            parent.postMessage(data, from);
        }
    });
})();
