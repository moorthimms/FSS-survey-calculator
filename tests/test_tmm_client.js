'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const code = fs.readFileSync('tmm_component/client.js', 'utf8');
function setup() {
    const elements = Object.fromEntries(['connect','disconnect','capture','status'].map(k => [k, {}]));
    const listeners = {}, docs = {}, output = [], intervals = [], timers = [];
    const parent = {postMessage:m => output.push(m)};
    let now = 100000;
    const document = {getElementById:id => elements[id], body:{scrollHeight:180}, hidden:false,
        addEventListener:(k, v) => { docs[k] = v; }};
    class WS {
        static all = [];
        constructor(url) { this.url = url; WS.all.push(this); }
        close() { this.closed = true; }
    }
    vm.runInNewContext(code, {document, window:{parent, addEventListener:(k,v) => {listeners[k]=v;}},
        WebSocket:WS, Date:{now:() => now}, setTimeout:fn => timers.push(fn), clearTimeout:()=>{},
        setInterval:fn => intervals.push(fn), clearInterval:()=>{}});
    const render = (args, source=parent) => listeners.message({source, data:{type:'streamlit:render',args}});
    const args = {nonce:'session',version:'V1',port:9636,canRecord:true};
    render(args);
    return {elements, WS, render, args, docs, document, timers, advance:ms => {now+=ms; intervals.forEach(f=>f());},
        last:() => output.filter(x=>x.type==='streamlit:setComponentValue').at(-1).value};
}
const valid = {latitude:30,longitude:78,utcTimeStamp:'2026-09-28T00:00:00Z',diffStatus:4,hrms:.01,vrms:.02};
test('phone WSS transport persists across rerenders; capture takes next sample only', () => {
    const s=setup(); s.elements.connect.onclick(); const ws=s.WS.all[0];
    assert.equal(ws.url,'wss://tmm-api-local.fieldsystems.trimble.com:9636/');
    ws.onopen(); ws.onmessage({data:JSON.stringify(valid)});
    s.render(s.args); assert.equal(s.WS.all.length,1); assert.equal(ws.closed,undefined);
    s.elements.capture.onclick(); assert.equal(s.last().capture,null);
    ws.onmessage({data:JSON.stringify({...valid,latitude:31})});
    assert.equal(s.last().capture.payload.latitude,31);
    s.elements.disconnect.onclick(); assert.equal(ws.closed,true);
    assert.equal(s.last().payload,null); assert.equal(s.last().connected,false);
});
test('bad data, stale stream, hidden page and old session clear position and capture', () => {
    const s=setup(); s.elements.connect.onclick(); let ws=s.WS.all[0]; ws.onopen();
    ws.onmessage({data:JSON.stringify(valid)}); s.advance(5001);
    assert.equal(s.last().payload,null); assert.equal(s.elements.capture.disabled,true);
    ws.onmessage({data:'not JSON'}); assert.equal(s.last().payload,null);
    ws.onmessage({data:JSON.stringify(valid)}); s.document.hidden=true; s.docs.visibilitychange();
    assert.equal(ws.closed,true); assert.equal(s.last().connected,false);
    s.render({...s.args,version:'V2',port:9640,nonce:'new'});
    s.elements.connect.onclick(); ws=s.WS.all.at(-1);
    assert.equal(ws.url,'wss://tmm-api-local.fieldsystems.trimble.com:9640/locationV2');
});
test('untrusted render messages ignored; connection error never keeps FIX', () => {
    const s=setup(); s.render({...s.args,port:1234},{}); s.elements.connect.onclick();
    const ws=s.WS.all[0]; assert.ok(ws.url.includes(':9636/'));
    ws.onopen(); ws.onmessage({data:JSON.stringify(valid)}); ws.onerror();
    assert.equal(s.last().connected,false); assert.equal(s.last().payload,null);
});
