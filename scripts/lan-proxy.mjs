#!/usr/bin/env node
// Exposes the local mcAI engine (viewer + API, bound to 127.0.0.1) on a LAN address.
// Usage: node scripts/lan-proxy.mjs [listenHost] [listenPort] [targetPort]
//   e.g. node scripts/lan-proxy.mjs 192.168.30.221 7878 7878
// WARNING: anyone on the network can then use the viewer — including starting AI builds
// (which cost API money) and undo. Only run it on networks you trust.
import http from 'node:http';
import net from 'node:net';

const listenHost = process.argv[2] ?? '0.0.0.0';
const listenPort = Number(process.argv[3] ?? 7878);
const targetPort = Number(process.argv[4] ?? 7878);
const target = `127.0.0.1:${targetPort}`;

function rewrite(headers) {
  const h = { ...headers, host: target };
  if (h.origin) h.origin = `http://${target}`;
  if (h.referer) h.referer = h.referer.replace(/^https?:\/\/[^/]+/, `http://${target}`);
  return h;
}

const server = http.createServer((req, res) => {
  const up = http.request(
    { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: rewrite(req.headers) },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    },
  );
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`mcAI engine not reachable on ${target}: ${e.message}`);
  });
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {
  const up = net.connect(targetPort, '127.0.0.1', () => {
    const h = rewrite(req.headers);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) for (const val of [].concat(v)) raw += `${k}: ${val}\r\n`;
    up.write(raw + '\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => { up.destroy(); socket.destroy(); };
  up.on('error', close);
  socket.on('error', close);
});

server.listen(listenPort, listenHost, () => {
  console.log(`mcAI LAN proxy: http://${listenHost}:${listenPort} → http://${target}`);
});
