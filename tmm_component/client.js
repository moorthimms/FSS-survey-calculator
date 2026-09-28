/* Browser-local TMM transport. No receiver sockets or credentials on the cloud server. */
(function () {
    'use strict';
    const get = id => document.getElementById(id);
    let args = {}, socket = null, latest = null, receivedAt = 0, capture = null;
    let armed = false, seq = 0, connected = false, connectionTimer = null, lastPublished = 0;
    let status = 'Ready to connect on this phone.';
    const fields = ['latitude','longitude','altitude','mslHeight','undulation','hrms','vrms',
        'diffAge','diffStatus','hdop','battery','satellites','totalSatInUse','receiverModel',
        'geoidModel','sourceReferenceFrameName','targetReferenceFrameName',
        'sourceReferenceFrameEpoch','targetReferenceFrameEpoch','sourceReferenceFrameEpsgCode',
        'targetReferenceFrameEpsgCode','diffID','utcTimeStamp'];
    function send(type, data) {
        window.parent.postMessage(Object.assign({isStreamlitMessage:true, type}, data), '*');
    }
    function emit(force = true) {
        if (!force && Date.now() - lastPublished < 1000) return;
        lastPublished = Date.now();
        send('streamlit:setComponentValue', {dataType:'json', value:{nonce:args.nonce,
            connected, status, payload:latest, receivedAt, capture, seq:++seq}});
    }
    function paint() {
        get('status').textContent = status;
        get('connect').disabled = !!socket;
        get('disconnect').disabled = !socket;
        get('capture').disabled = !connected || !latest || !args.canRecord || armed;
        get('capture').textContent = armed ? 'Waiting for next position…' : 'Record next position';
        send('streamlit:setFrameHeight', {height:document.body.scrollHeight + 20});
    }
    function stop(message) {
        const old = socket; socket = null;
        if (old) { old.onopen = old.onmessage = old.onerror = old.onclose = null; old.close(); }
        clearTimeout(connectionTimer);
        connected = false; latest = null; receivedAt = 0; capture = null; armed = false;
        status = message; paint(); emit();
    }
    function endpoint() {
        const port = Number(args.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid TMM port.');
        if (!['V1','V2'].includes(args.version)) throw Error('Select a supported TMM API.');
        return `wss://tmm-api-local.fieldsystems.trimble.com:${port}/${args.version === 'V2' ? 'locationV2' : ''}`;
    }
    get('connect').onclick = () => {
        stop('Connecting to Mobile Manager on this phone…');
        try {
            const ws = new WebSocket(endpoint()); socket = ws; paint();
            connectionTimer = setTimeout(() => {
                if (socket === ws && !connected) stop('Connection timed out. Open TMM on this phone, check internet/DNS, its secure API port, and browser local-network permission.');
            }, 10000);
            ws.onopen = () => {
                if (socket !== ws) return;
                clearTimeout(connectionTimer); connected = true;
                status = 'Connected to TMM; waiting for receiver positions.'; paint(); emit();
            };
            ws.onmessage = event => {
                if (socket !== ws) return;
                const force = armed || !latest;
                const previousStatus = latest?.diffStatus;
                try {
                    if (typeof event.data !== 'string' || event.data.length > 131072) throw Error();
                    const raw = JSON.parse(event.data);
                    if (!raw || Array.isArray(raw) || typeof raw !== 'object' || !('latitude' in raw)) throw Error();
                    latest = Object.fromEntries(fields.map(k => [k, raw[k] ?? null]));
                    receivedAt = Date.now();
                    status = 'Receiving TMM positions. Quality and height checks appear below.';
                    if (armed) { capture = {id:Date.now() + '-' + seq, payload:latest, receivedAt}; armed = false; }
                } catch (_) {
                    latest = null; receivedAt = 0; capture = null; armed = false;
                    status = 'Unsupported or malformed TMM data. Check the selected API and port.';
                }
                paint(); emit(force || !latest || previousStatus !== latest.diffStatus);
            };
            ws.onerror = () => {
                if (socket === ws) stop('Could not connect. Check TMM is running on this phone, secure API support, browser permissions and V2 registration. Wi-Fi pairing alone is insufficient.');
            };
            ws.onclose = () => { if (socket === ws) stop('TMM disconnected. Reconnect after checking the receiver.'); };
        } catch (_) { stop('Secure TMM connection could not start. Check browser support and the configured port.'); }
    };
    get('disconnect').onclick = () => stop('Disconnected.');
    get('capture').onclick = () => {
        if (!connected || !latest || !args.canRecord) return;
        armed = true; capture = null; paint();
    };
    window.addEventListener('message', event => {
        if (event.source !== window.parent || event.data?.type !== 'streamlit:render') return;
        const next = event.data.args || {};
        const changed = args.nonce !== next.nonce || args.port !== next.port || args.version !== next.version;
        args = next;
        if (changed) stop('Ready to connect on this phone.');
        if (!args.canRecord) armed = false;
        paint();
    });
    const heartbeat = setInterval(() => {
        if (!socket) return;
        if (receivedAt && Date.now() - receivedAt > 5000) {
            latest = null; capture = null; armed = false;
            status = 'Receiver data is stale. Recording is disabled; check TMM and the R12.';
        }
        paint(); emit(false);
    }, 1000);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop('Page paused. Return here and reconnect for a fresh position.');
    });
    window.addEventListener('pagehide', () => { clearInterval(heartbeat); stop('Page closed.'); });
    send('streamlit:componentReady', {apiVersion:1}); paint();
}());
