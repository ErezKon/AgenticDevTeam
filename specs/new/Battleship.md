# Home Assignment: Battleship

**Time estimate:** ~45 minutes

## The Task

Build a **Battleship** game as a full-stack web application. Two players, each with a **6x6 board** and **3 ships** (sizes: 2, 3, 4). Players place their ships, then take turns firing at each other's board. First to sink all opponent ships wins.

- **FastAPI** python backend that manages the game: board state, ship placement validation, turn logic, hit/miss/sunk detection. Expose REST endpoints for placing ships, firing shots, and viewing boards. Important: a player should never see the opponent's ship positions — only their own hits and misses.
- **Angular** frontend that shows both grids (your board + your attack view of the opponent), lets you place ships and fire shots. Only Player 1 needs UI controls — Player 2 can be idle for now.
- **Docker Compose** with all services containerized. Each service can expose its own port.

A single `docker compose up --build` should bring everything up.

## Deliverables

1. Source code (Git repo or zip) with a `docker-compose.yml` at the root
2. A brief `README.md` explaining how to run the project

## What We're Looking For

Clean, readable code. A working game. Correct use of FastAPI and Angular. Solid Docker setup. Design decisions are yours — we'll discuss them in the follow-up.

## Not Required

Persistent storage, authentication, tests, polished UI.

## Follow-Up Session (~30 minutes)

After submission we'll do a live session: walk through your solution, debug together, extend the app with a new feature, and discuss architecture trade-offs. Come ready to share your screen.

Good luck, have fun!
