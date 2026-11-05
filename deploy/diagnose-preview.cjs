// Pi-Anzeige diagnosis: triggers each preview-related CDP call on its own,
// so you can watch the screen and note which step makes it jump.
const WebSocket = require('/opt/pi-anzeige/node_modules/ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.method === 'Page.screencastFrame') send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });

  const steps = [
    ['A', 'Screenshot in voller Größe', async () => { await send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }); }],
    ['B', 'Screencast mit maxWidth 960 (3 s)', async () => { await send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 960 }); await sleep(3000); await send('Page.stopScreencast'); }],
    ['C', 'Screencast ohne maxWidth (3 s)', async () => { await send('Page.startScreencast', { format: 'jpeg', quality: 60 }); await sleep(3000); await send('Page.stopScreencast'); }],
    ['D', 'Screenshot verkleinert (alte Version)', async () => { await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 0.5 } }); }],
  ];
  for (const [key, label, run] of steps) {
    console.log(`\nSchritt ${key} in 5 s: ${label} – bitte auf den Bildschirm schauen`);
    await sleep(5000);
    console.log(`>>> ${key} läuft`);
    await run();
    console.log(`<<< ${key} fertig`);
  }
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
