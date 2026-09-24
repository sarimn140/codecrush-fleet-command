# Fleet Command — Maritime Operations & Fleet Simulation

A real-time maritime fleet command and simulation platform developed for the CodeRush hackathon.

Fleet Command provides live vessel tracking, Command/Captain role-based workflows, AI-assisted distress analysis, weather-aware routing, restricted zones, proximity alerts, fuel monitoring, ship-to-ship assistance, predictive alerts, fleet decision support, and historical playback.

## Key Features

* Real-time tracking of 15 vessels
* Command and Captain operational views
* WebSocket-based live synchronization
* AI-assisted distress message analysis
* Automatic severity and incident classification
* Injury and damage extraction from distress messages
* Weather-aware route planning
* Restricted-zone detection and rerouting
* Geofence and proximity alerts
* Fuel monitoring and predictive fuel warnings
* Multiple route comparison
* Ship-to-ship assistance requests
* Medical, fuel, escort, and cargo assistance workflows
* Fleet Advisor decision-support panel
* Historical playback
* Responsive maritime operations interface
* Docker-based deployment

## Technology Stack

### Frontend

* HTML5
* CSS3
* Vanilla JavaScript
* Leaflet
* Leaflet Draw

### Backend

* Node.js
* Express.js
* WebSocket
* REST API

### AI / NLP

* Rule-based distress-message extraction
* Optional Claude API refinement

### External Services

* Open-Meteo for weather data
* OpenStreetMap tiles for map visualization

### Deployment

* Docker
* Docker Compose

## Project Architecture

```text
codecrush/
│
├── backend/
│   ├── public/
│   │   ├── index.html
│   │   ├── app.js
│   │   ├── style.css
│   │   ├── theme.js
│   │   └── favicon.svg
│   │
│   ├── lib/
│   │   ├── simulation.js
│   │   ├── routing.js
│   │   ├── geo.js
│   │   ├── weather.js
│   │   └── nlp.js
│   │
│   ├── fleet.json
│   ├── server.js
│   ├── package.json
│   └── Dockerfile
│
├── docker-compose.yml
├── .env.example
├── DEMO-CHECKLIST.md
└── README.md
```

## How to Run

### Requirements

Install:

* Docker Desktop
* Git

### Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/codecrush-fleet-command.git
cd codecrush-fleet-command
```

### Start the application

```bash
docker compose up --build
```

Once the container starts, open:

```text
http://localhost:8080
```

The complete application runs through a single Docker service.

## Optional AI Configuration

The system works without an API key because the distress analysis includes a rule-based NLP system.

For optional Claude-based refinement:

```bash
cp .env.example .env
```

Then add your API key:

```env
ANTHROPIC_API_KEY=your_api_key_here
```

Never commit the `.env` file to GitHub.

## Core System Components

### Fleet Simulation

The simulator updates vessel positions every second and maintains the current state of the fleet.

### Routing

A visibility-graph routing approach is used to calculate valid paths around restricted areas and navigable-water boundaries.

### Weather

Open-Meteo provides live weather information. Weather conditions can influence route selection and fuel consumption.

### Distress Analysis

Free-form distress messages are analyzed to extract information such as:

* Incident category
* Severity
* Number of injured crew
* Damage information
* Operational risk

### Real-Time Communication

WebSocket communication keeps multiple connected clients synchronized with the same fleet state.

### Restricted Zones

Command users can create restricted zones. Affected vessels can automatically receive rerouting behavior and alerts.

### Ship-to-Ship Assistance

Captains can request:

* Medical assistance
* Fuel transfer
* Escort
* Cargo offload

Other vessels can accept assistance requests and travel toward the requesting vessel.

### Fleet Advisor

The Fleet Advisor provides operational information related to:

* Distressed vessels
* Fuel-risk vessels
* Weather exposure
* Pending directives
* Assistance requests

### Playback

The system maintains historical fleet snapshots that can be reviewed using the Playback interface.

## User Roles

### Command

Command users can:

* Monitor the complete fleet
* Select vessels
* Create restricted zones
* Send vessel directives
* Compare routes
* Monitor alerts
* View fleet-wide operational information
* Dispatch assistance

### Captain

Captain users can:

* Monitor an assigned vessel
* Receive Command directives
* Accept or escalate directives
* Submit distress messages
* Request assistance
* Accept assistance requests from other vessels

## Demo

A complete demonstration sequence is available in:

```text
DEMO-CHECKLIST.md
```

The checklist covers:

1. Fleet tracking
2. Captain mode
3. Medical assistance
4. Fuel assistance
5. Escort assistance
6. Cargo assistance
7. Command directives
8. Distress NLP
9. Restricted zones
10. Route comparison
11. Proximity alerts
12. Weather and fuel
13. Predictive alerts
14. Fleet Advisor
15. Playback
16. Multi-client WebSocket testing

## Design

Fleet Command uses a dark maritime operations-console interface with a map-first layout, operational metrics, fleet monitoring, alerts, route information, and responsive controls.

## Project Purpose

The project demonstrates how real-time simulation, geospatial processing, routing algorithms, WebSocket communication, NLP, weather data, and operational decision-support workflows can be combined into a unified maritime command platform.

## Future Improvements

Potential future improvements include:

* Production authentication
* Persistent database storage
* Advanced vessel telemetry
* Role-based authorization
* Cloud deployment
* More advanced AI decision support
* Real-time AIS integration
* Improved route optimization
* Scalable multi-region infrastructure

## License

This project was developed as a hackathon project and educational demonstration.
