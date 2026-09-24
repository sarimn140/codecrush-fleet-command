'use strict';
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { Simulation } = require('./lib/simulation');
const nlp = require('./lib/nlp');

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sim = new Simulation();
sim.start();

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

sim.onUpdate((event) => broadcast(event));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', ...sim.getState() }));
  ws.on('message', () => {}); // clients only push via REST, ws is push-only for state
});

// ---------- REST API ----------

app.get('/api/state', (req, res) => res.json(sim.getState()));

app.get('/api/history', (req, res) => {
  const minutes = Math.min(parseInt(req.query.minutes || '60', 10), 60);
  res.json({ resolutionSeconds: 30, windowMinutes: minutes, snapshots: sim.getHistory(minutes) });
});

app.post('/api/zones', (req, res) => {
  const { name, polygon } = req.body;
  if (!Array.isArray(polygon) || polygon.length < 3) return res.status(400).json({ error: 'polygon must have >=3 points' });
  const zone = sim.drawZone(name, polygon);
  res.json(zone);
});

app.put('/api/zones/:id', (req, res) => {
  const zone = sim.editZone(req.params.id, req.body.polygon);
  if (!zone) return res.status(404).json({ error: 'zone not found' });
  res.json(zone);
});

app.delete('/api/zones/:id', (req, res) => {
  sim.deleteZone(req.params.id);
  res.json({ ok: true });
});

app.get('/api/routes/:shipId/options', (req, res) => {
  const result = sim.getRouteOptions(req.params.shipId);
  if (!result) return res.status(404).json({ error: 'ship not found' });
  res.json(result);
});

app.post('/api/routes/:shipId/apply', (req, res) => {
  const ship = sim.applyRoute(req.params.shipId, req.body.waypoints);
  if (!ship) return res.status(400).json({ error: 'invalid route or ship' });
  broadcast({ type: 'route_applied', shipId: ship.shipId, waypoints: ship.route });
  res.json({ ok: true, ship });
});

app.get('/api/advisor', (req, res) => res.json(sim.getAdvisor()));
app.get('/api/assistance', (req, res) => res.json({ requests: sim.assistanceList() }));

app.post('/api/assistance/:shipId', (req, res) => {
  const { type = 'medical_aid', note = '' } = req.body || {};
  const request = sim.requestAssistance(req.params.shipId, type, note);
  if (!request) return res.status(404).json({ error: 'ship not found' });
  broadcast({ type: 'assistance_request', request, requests: sim.assistanceList() });
  res.json(request);
});

app.post('/api/assistance/:id/accept', (req, res) => {
  const request = sim.acceptAssistance(req.params.id, req.body.helperShipId);
  if (!request) return res.status(400).json({ error: 'request or helper ship not found, or helper cannot be assigned' });
  broadcast({ type: 'assistance_accepted', request, requests: sim.assistanceList() });
  res.json(request);
});

app.post('/api/assistance/:id/decline', (req, res) => {
  const request = sim.declineAssistance(req.params.id);
  if (!request) return res.status(404).json({ error: 'assistance request not found' });
  broadcast({ type: 'assistance_declined', request, requests: sim.assistanceList() });
  res.json(request);
});

app.post('/api/directives/:shipId', (req, res) => {
  // body: { type: 'reroute_port'|'divert_waypoint'|'hold_position', destination?, waypoint? }
  const directive = sim.issueDirective(req.params.shipId, req.body);
  if (!directive) return res.status(404).json({ error: 'ship not found' });
  broadcast({ type: 'directive', shipId: req.params.shipId, directive });
  res.json(directive);
});

app.post('/api/captain/:shipId/respond', async (req, res) => {
  const { action, message } = req.body;
  if (action === 'ESCALATE_DISTRESS') {
    const nlpResult = await nlp.extractDistress(message || '');
    const result = sim.captainRespond(req.params.shipId, { action, message });
    sim.fileDistress(req.params.shipId, nlpResult);
    broadcast({ type: 'captain_response', shipId: req.params.shipId, action, nlpResult });
    return res.json({ ...result, nlpResult });
  }
  const result = sim.captainRespond(req.params.shipId, { action });
  if (!result) return res.status(404).json({ error: 'no pending directive' });
  broadcast({ type: 'captain_response', shipId: req.params.shipId, action });
  res.json(result);
});

// Free-standing distress endpoint (captain can also file distress without a directive)
app.post('/api/captain/:shipId/distress', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const nlpResult = await nlp.extractDistress(message);
  sim.fileDistress(req.params.shipId, nlpResult);
  broadcast({ type: 'distress', shipId: req.params.shipId, nlpResult });
  res.json({ ok: true, nlpResult });
});

app.post('/api/alerts/:id/ack', (req, res) => {
  const alert = sim.acknowledgeAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: 'alert not found' });
  broadcast({ type: 'alert_ack', id: req.params.id });
  res.json(alert);
});

app.get('/api/ports', (req, res) => res.json(sim.ports));

server.listen(PORT, () => console.log(`Fleet command server listening on :${PORT}`));
