# Pac-Man Multiplayer & Competitive Modes — Enhancement Spec

This spec extends the existing single-player Pac-Man game to support multiplayer and competitive gameplay modes.

## Goals

- Allow two or more human players to play Pac-Man-related modes together.
- Reuse as much of the existing game logic, rendering, and assets as possible.
- Keep latency and synchronization requirements realistic for a browser-based implementation.

## New Modes

### 1. Local Co-Op (Shared Keyboard / Gamepads)

- Two players share the same maze.
- Both control their own Pac-Man-like characters (different colors).
- Rules:
  - Dots and power pellets are shared; once eaten, they disappear for both players.
  - If **either** player is caught by a ghost, that player loses a life, but the level continues for the other.
  - The level ends when all dots are eaten or all players are out of lives.
- Scoring:
  - Each player has their own score.
  - Ghosts eaten and fruits collected are credited individually.

### 2. Competitive "Score Attack" (Online Optional)

- Each player runs their own separate instance of the maze and ghosts.
- Players have a fixed time window (e.g., 3 or 5 minutes).
- The winner is whoever has the highest score at the end.
- Stretch goal: allow real-time online play where players see each other's scores updating live.

### 3. Ghost vs Pac-Man Mode (Asymmetric Multiplayer)

- One player is Pac-Man.
- Up to three other players control the ghosts.
- Pac-Man's objective: collect a certain percentage of dots or survive for a fixed amount of time.
- Ghost players share a combined score based on how quickly they catch Pac-Man and how few lives he has remaining at the end.

## Technical Considerations

- Input handling should support:
  - Keyboard controls for at least two players on the same machine.
  - (Optional) Gamepad support where available.
- For online modes, assume a simple client/server model:
  - One authoritative server per match.
  - Clients send input events and receive periodic state updates.
- Networked modes should be resilient to minor lag:
  - Use interpolation/smoothing for positions.
  - Implement basic client-side prediction if needed (design-level only; full networking stack does not have to be implemented now).

## UI & UX

- Add a main menu that lets players choose between:
  - Classic Single Player
  - Local Co-Op
  - Score Attack
  - Ghost vs Pac-Man
- Show player indicators and scores clearly on-screen in all modes.
- For online modes, display connection status and a way to leave a match and return to the main menu.

## Out of Scope for This Iteration

- Ranked matchmaking or persistent player profiles.
- Cross-platform account systems.
- Voice or text chat.
