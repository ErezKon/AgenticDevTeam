# QA Lead — Test Plan

**Agent**: qa-lead  
**Generated**: 2026-08-07T14:16:26.341Z

---

## Test Plan

{
  "scope": "User stories were not supplied; this test plan derives coverage from the core Battleship functionality described in the architecture and ensures all critical paths are exercised.",
  "unit": [
    {
      "target": "battleship.domain.board.Board",
      "description": "Validate board initialization, ship placement bounds, and overlap detection logic.",
      "framework": "pytest",
      "storyId": "S1",
      "acIndex": 0
    },
    {
      "target": "battleship.domain.ship.Ship",
      "description": "Verify ship size, orientation handling, and cell generation.",
      "framework": "pytest",
      "storyId": "S1",
      "acIndex": 1
    },
    {
      "target": "battleship.domain.game.Game",
      "description": "Test turn management, hit/miss/sunk detection, and win condition evaluation.",
      "framework": "pytest",
      "storyId": "S2",
      "acIndex": 0
    },
    {
      "target": "battleship.domain.mcp.MCPHandler",
      "description": "Unit‑test MCP command parsing and translation into domain actions.",
      "framework": "pytest",
      "storyId": "S3",
      "acIndex": 0
    }
  ],
  "integration": [
    {
      "target": "POST /games/{game_id}/players/{player_id}/place_ship",
      "description": "Validate request payload, invoke domain placement logic, persist ship cells, and return appropriate HTTP status.",
      "framework": "pytest",
      "storyId": "S1",
      "acIndex": 2
    },
    {
      "target": "POST /games/{game_id}/shots",
      "description": "Ensure shot firing endpoint records the shot, calls game logic for hit detection, and returns hit/miss/sunk result.",
      "framework": "pytest",
      "storyId": "S2",
      "acIndex": 1
    },
    {
      "target": "GET /games/{game_id}/board?player_id={player_id}",
      "description": "Confirm board view hides opponent ship positions while showing own ships and shot results.",
      "framework": "pytest",
      "storyId": "S2",
      "acIndex": 2
    },
    {
      "target": "POST /mcp/action",
      "description": "Test MCP Tool Server endpoint processes an AI action, forwards to domain logic, and returns the updated game state.",
      "framework": "pytest",
      "storyId": "S3",
      "acIndex": 1
    }
  ],
  "e2e": [
    {
      "scenario": "Player places all ships and starts the game",
      "description": "User drags ships onto the board, confirms placement, and sees the game transition to the firing phase.",
      "criticalPath": true,
      "storyId": "S1",
      "acIndex": 3
    },
    {
      "scenario": "Player fires a shot and receives correct hit/miss feedback",
      "description": "User selects a target cell, fires, and the UI updates with hit or miss indicator and updates opponent board view.",
      "criticalPath": true,
      "storyId": "S2",
      "acIndex": 3
    },
    {
      "scenario": "Turn enforcement prevents out‑of‑turn actions",
      "description": "When it is not the player's turn, the fire button is disabled and an informational message is shown.",
      "criticalPath": true,
      "storyId": "S2",
      "acIndex": 4
    },
    {
      "scenario": "AI player makes a move via MCP and UI reflects the result",
      "description": "After the human player fires, the AI (via MCP) automatically takes a shot; the UI updates with the AI's hit/miss outcome.",
      "criticalPath": true,
      "storyId": "S3",
      "acIndex": 2
    }
  ],
  "coverageTargets": {
    "unit": 85,
    "integration": 70,
    "e2e": 100
  }
}
