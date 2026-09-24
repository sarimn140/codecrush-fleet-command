# Fleet Command — Strait of Hormuz Crisis

A real-time fleet command system built for the Code Rush hackathon brief: 15 ships,
live tracking, role-based Command/Captain control, AI distress parsing,
weather-aware routing, restricted zones, proximity/geofence alerts, and playback.

## Run it

```bash
docker compose up --build
```

Then open **http://localhost:8080**. That's the whole system — one container runs
the Express + WebSocket backend and serves the frontend as static files, so there's
nothing else to start.

No API keys are required to run the full system. Optional:

```bash
cp .env.example .env
# fill in ANTHROPIC_API_KEY if you want the Claude-refined distress extraction pass
docker compose up --build
```

## Architecture

```
backend/
  server.js            Express REST API + WebSocket broadcast
  lib/
    simulation.js       Tick loop (1Hz), ship state, alerts, history ring buffer
    routing.js           Visibility-graph pathfinding (zones + navigable water)
    geo.js               Haversine, bearing, point-in-polygon, segment intersection
    weather.js           Live Open-Meteo integration (free tier, no key needed)
    nlp.js               Rule-based distress-message extraction (+ optional Claude refine)
  public/                Static frontend: Leaflet map + vanilla JS, no build step
  fleet.json             Provided scenario data (unchanged)
docker-compose.yml
```

One service, one container, no cloud dependencies except the two live third-party
APIs the frontend/backend reach out to over the network (Open-Meteo for weather,
and OpenStreetMap tile servers for the basemap — the spec explicitly allows
hardcoded/external basemap tiles). Everything else (ships, zones, alerts, AI
extraction) is computed live by this system.

## How each requirement is met

**Simulator / ship movement** — `simulation.js` runs a `setInterval` tick at 1000ms
(1 Hz, matches "1Hz or faster"). Each tick advances every ship along its current
heading by `speed × dt`, using great-circle math (`geo.destinationPoint`) so motion
is accurate at this scale, not flat-plane.

**Routing** — `routing.js` implements a visibility-graph shortest path: nodes are
the start, the destination, every restricted-zone vertex (nudged outward so paths
can graze around a zone), and every navigable-water boundary vertex (so a ship can
hug the strait's edge as a last resort). An edge is valid only if the straight
segment (a) doesn't cross any zone and (b) samples entirely inside the navigable
polygon. Dijkstra finds the shortest valid path. Weather is folded in as an edge
cost multiplier (adverse-weather segments cost 60% more), so reroutes naturally
prefer clearer paths. If no path exists, the ship goes `stranded` and fires an alert
— this satisfies the "boxed in" edge case explicitly.

**Reroute triggers** — A new zone drawn over an active path triggers immediate
recomputation for every affected ship (`Simulation.drawZone`). A captain accepting
a directive (`reroute_port`, `divert_waypoint`, `hold_position`) triggers a
recompute on the next tick. A ship found inside a zone it's already in also
triggers a geofence breach alert + reroute-out attempt, per the edge case in the
spec.

**Weather** — `weather.js` calls the real Open-Meteo API (no key required),
snapping to a 0.5° grid and caching 10 minutes to stay well within free-tier
limits with 15 ships ticking at 1Hz. Adverse weather (gusts > 25kt, precipitation,
or storm-class WMO codes) applies a 30% fuel burn multiplier exactly as specified,
and is factored into route cost so reroutes prefer clear paths. If the network call
fails (e.g. rate limited, or the grading laptop has no internet), the sampler fails
safe to "calm / no data" rather than crashing the simulation, and the response is
labeled with its source so this is never silently wrong.

**Fuel** — Burn is a function of speed and adverse weather; `insufficient_fuel`
status is flagged the moment the estimated burn for the current route exceeds
remaining fuel (ship keeps sailing, per spec), and `out_of_fuel` triggers a
critical alert and stops the ship once it actually hits zero.

**Real-time sync** — WebSocket (`ws`) push-only channel; every tick broadcasts full
ship/zone/alert state to all connected clients, so five-plus viewers always see
identical state (there is no per-client state — the server is the single source of
truth). The client interpolates position over ~950ms between ticks
(`animateMarkerTo`) so motion looks continuous without ever exceeding the reported
speed, since the server has already computed the real end position.

**Roles** — A role switch (Command / Captain) in the top bar. Command sees the
whole fleet, can draw/edit/delete restricted zones (Leaflet.draw, hidden entirely
for Captains), and can issue directives to any ship from its detail modal. Captain
is scoped to one selected ship: receives directives and must respond ACCEPT or
ESCALATE_DISTRESS (free-form text), and can also file a distress message
proactively. Every response broadcasts over the same WebSocket channel so Command
sees it immediately.

**AI / NLP** — `nlp.js` extracts category (fire, flooding, engine failure,
collision, grounding, piracy, medical, cargo, weapons/naval), severity
(low/medium/high/critical, weighted keyword scoring plus injury-count and
fatality boosts), injury counts, and damage estimates from free-form distress text,
entirely rule-based so it always works with zero setup. If `ANTHROPIC_API_KEY` is
set, a second pass asks Claude to refine/confirm the same structured JSON — this is
additive and optional, never required for the feature to function. Extracted
severity drives the alert's severity level and how it's displayed/sorted.

**Zones / alerts** — Command draws polygons with Leaflet.draw; Captains see them
read-only. Geofence breach, proximity warning (<2km, checked every tick across all
pairs), distress, out-of-fuel, and stranded alerts all flow through one alert
pipeline, sortable by severity, with an acknowledge action that stays server-side
so all clients agree on ack state. An audio cue plays on new high/critical alerts.

**Playback** — The simulation keeps a 30-second-resolution ring buffer covering the
last hour (`simulation.js` history array, trimmed every tick). `/api/history`
returns it; the Playback tab loads it and scrubs ship markers to historical
positions with a slider, then a "Back to live" button resumes the live feed. Per
spec, this is snapshot scrubbing, not full state reconstruction at arbitrary
timestamps.

## Documented assumptions

- **Auth**: there's no login system. Role and ship selection are chosen from a
  dropdown in the UI (documented here since the spec didn't specify auth). In a
  production system this would be a real per-captain login.
- **Fuel burn model**: the spec gives no formula, only "30% extra in adverse
  weather" and the 15 ships' starting fuel loads. We use
  `burn ∝ speed^1.3 × distance`, tuned so the provided fuel values are meaningful
  (some ships, like MV-7 "Gharial" with only 750t, are intentionally fuel-critical
  at the scenario's start — that's in the provided fleet.json, not something we
  added).
- **Routing algorithm**: spec explicitly allows any valid approach ("A* on a grid,
  visibility graph, naive... all valid — we're testing the behavior"). We chose a
  visibility graph because it gives clean, ship-realistic routes around polygonal
  zones without a grid-resolution tradeoff.
- **"Everyone watching within 500ms"**: satisfied structurally — the server
  broadcasts once per tick to every open WebSocket connection synchronously; there
  is no per-client polling delay. Actual latency depends on the judge's machine/
  network, which we can't control from here.
- **Divert-to-waypoint directive**: ship sails straight to the waypoint (bypassing
  normal zone-avoiding routing for that leg, since Command explicitly chose the
  point), then resumes normal routing to its destination once it arrives.
- **Multiple simultaneous distress escalations**: each is independent per ship;
  there's no fleet-wide distress queue beyond the shared alert list.

## Bonus tier implemented

All four optional bonus areas are now included in this build:

1. **Multiple route options** — Command can compare fastest, safer, and fuel-efficient candidate routes and apply a selected valid route.
2. **Ship-to-ship assistance** — A Captain can broadcast a medical, fuel, escort, or cargo-offload request. Command can assign an available vessel to an open request.
3. **Predictive alerts** — The simulator warns before a ship is projected to enter a restricted zone within roughly three minutes or run out of fuel before completing its current route.
4. **Fleet advisor** — The Command interface includes a live decision-support panel that summarizes distressed vessels, fuel-risk vessels, adverse-weather exposure, pending captain directives, and open assistance requests.

These bonuses are additive to the core implementation and are designed to keep the system runnable locally without introducing another required service.

## Interface redesign

The frontend was redesigned as an operations console rather than a generic dashboard: restrained maritime colors, compact information hierarchy, map-first layout, vessel search, fleet metrics, live connection state, operational legend, route comparison, advisor panel, and responsive behavior. The application remains vanilla HTML/CSS/JavaScript with Leaflet; there is no frontend framework or build step.

## Final UI / assistance update

This build uses a dark maritime operations console with Rajdhani and JetBrains Mono typography.
The Captain assistance workflow is persistent across 1 Hz fleet updates, so selecting Medical aid,
Fuel transfer, Escort, or Cargo offload no longer loses the interaction during a live tick.
Captains can also receive open assistance calls and accept or decline them. Accepted helpers travel
toward the requesting vessel; arrival completes the assistance mission and generates a live alert.

See `DEMO-CHECKLIST.md` for the exact live demonstration sequence.
