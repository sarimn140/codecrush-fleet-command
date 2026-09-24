# Fleet Command — Live Demo & Grading Checklist

Use this exact order for the final demonstration.

## 1. Start

```bash
docker compose up --build
```

Open `http://localhost:8080`.

Confirm the top bar shows **15 / 15** and **Live**.

## 2. Fleet tracking

1. Wait 10 seconds.
2. Confirm all 15 vessels remain visible in the Fleet panel.
3. Click **Aurora** in the Fleet list.
4. Confirm the card highlights and the map focuses/selects Aurora.
5. Click another vessel, e.g. **Borealis**.
6. Confirm the selected vessel changes immediately.

## 3. Captain selection

1. Switch View to **Captain**.
2. Select **Aurora** from the Ship selector or click Aurora in Fleet.
3. Confirm Aurora appears in Captain View.
4. Click **Borealis** in Fleet.
5. Confirm Captain View changes to Borealis.

## 4. Medical assistance — main bonus demonstration

1. Select **Aurora**.
2. Stay in **Captain** view.
3. Under **SHIP-TO-SHIP ASSISTANCE**, click the **MED** card.
4. Confirm it stays selected and the panel does NOT close.
5. Enter:

   `2 crew members injured and require urgent medical assistance.`

6. Click **BROADCAST ASSISTANCE REQUEST**.
7. Confirm the button changes to **REQUEST ACTIVE**.
8. Switch to another Captain vessel, e.g. Borealis.
9. Confirm **INCOMING ASSISTANCE CALLS** appears.
10. Click **ACCEPT**.
11. Confirm Borealis receives an active assistance mission.
12. Wait until the helper reaches the requesting vessel.
13. Confirm an **assistance arrived** alert appears and the request becomes completed.

## 5. Other assistance types

Repeat the same workflow with:

- Fuel transfer
- Escort
- Cargo offload

Use different requesting/helper ships for each test.

## 6. Command directive

1. Switch to **Command**.
2. Click a vessel.
3. Open its detail panel.
4. Send a **Reroute to different port** directive.
5. Switch to that vessel's Captain view.
6. Click **ACCEPT**.
7. Confirm the vessel changes route.

Then repeat once with **ESCALATE DISTRESS**.

## 7. Distress NLP

Send:

`Engine failure, severe flooding and 3 crew members are injured.`

Confirm the result shows extracted severity/categories/injury count and a distress alert appears.

## 8. Restricted-zone test

1. Go to Command.
2. Use the polygon drawing tool.
3. Draw a restricted zone over a vessel or across its planned route.
4. Confirm a geofence/rerouting alert appears.
5. Confirm the vessel changes status to rerouting and follows a new route.

## 9. Route options bonus

1. Select a vessel.
2. Open its detail panel.
3. Click **Compare routes**.
4. Show the alternative route cards.
5. Apply one route.
6. Confirm the vessel follows the selected route.

## 10. Proximity warning

Bring/place two vessels within 2 km using the simulator state/test controls.
Confirm a proximity warning appears.

## 11. Weather and fuel

Show the weather status for a vessel.
When adverse weather is active, confirm the fuel burn uses the required 30% penalty.

## 12. Predictive alerts

Show the Alerts panel and demonstrate a predictive fuel or restricted-zone warning when the simulator conditions trigger it.

## 13. Fleet Advisor bonus

1. Click **FLEET ADVISOR**.
2. Show operational recommendations.
3. If an assistance request is open, show the request in the advisor.
4. Demonstrate Command dispatch/decline if needed.

## 14. Playback

1. Open **Playback**.
2. Click **Load history**.
3. Move the timeline slider backward.
4. Show historical ship positions.
5. Click **Return to live**.

## 15. Five-user WebSocket test

Open five browser tabs/windows connected to the same server.

Recommended:

- Tab 1: Command
- Tab 2: Captain — Aurora
- Tab 3: Captain — Borealis
- Tab 4: Command
- Tab 5: Captain — Cygnus

Confirm all tabs show the same fleet movement and state.

## 16. Final proof

Before submitting, show:

- 15/15 fleet
- Live connection
- Ship selection
- Captain/Command roles
- Medical assistance accepted by another captain
- Assistance arrival/completion
- Distress NLP
- Restricted zone + reroute
- Route alternatives
- Proximity alert
- Weather/fuel penalty
- Predictive alert
- Fleet Advisor
- Playback
- Five connected clients

Keep the browser DevTools Console open during your own test. There should be no red JavaScript errors.
