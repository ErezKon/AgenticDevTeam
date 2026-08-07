# Requirements Traceability Matrix

**Agent**: conductor  
**Generated**: 2026-08-07T14:19:56.267Z

---

## Requirements Traceability Summary

| Metric | Value |
|--------|-------|
| Total acceptance criteria | 23 |
| Verified (merged + test passed) | 0 |
| Implemented but untested | 20 |
| Planned only (no merged PR) | 3 |
| Missing (no assignment) | 0 |
| Coverage | 0.0% |

## Traceability Matrix

| Epic | Story | AC# | Acceptance Criterion | Status | PRs | Tests |
|------|-------|-----|----------------------|--------|-----|-------|
| E1 | US-001 | 0 | The UI allows selecting a ship size (2, 3, 4) and dragging it onto board cells; placement is rejected if the ship would exceed board bounds or overlap another ship. | implemented-untested | #1 (merged) | -- |
| E1 | US-001 | 1 | The backend endpoint POST /place_ship returns a success response for valid placements and an error with a clear message for invalid placements. | implemented-untested | #1 (merged) | -- |
| E1 | US-001 | 2 | After a successful placement, the player's board view visually displays the ship positions. | implemented-untested | #1 (merged) | -- |
| E2 | US-002 | 0 | Clicking a cell on the opponent grid sends a shot request to POST /fire. | implemented-untested | #4 (merged) | -- |
| E2 | US-002 | 1 | The backend enforces turn order and returns an error if it is not the player's turn. | implemented-untested | #4 (merged) | -- |
| E2 | US-002 | 2 | The response indicates hit, miss, or sunk, and the UI updates the opponent view accordingly. | implemented-untested | #4 (merged) | -- |
| E3 | US-003 | 0 | GET /board/{player_id} returns the full board with ship locations for the requesting player. | planned-only | #3 (open) | -- |
| E3 | US-003 | 1 | GET /opponent_view/{player_id} returns a masked board showing only hit/miss markers, never ship positions. | planned-only | #3 (open) | -- |
| E3 | US-003 | 2 | The frontend fetches these endpoints after each action and updates both grids correctly. | planned-only | #3 (open) | -- |
| E4 | US-004 | 0 | The MCP Tool Server exposes `place_ship` and `fire_shot` methods over Streamable HTTP. | implemented-untested | #2 (merged) | -- |
| E4 | US-004 | 1 | A client using the Model Context Protocol SDK can call these methods and receives the same response schema as the REST API. | implemented-untested | #2 (merged) | -- |
| E4 | US-004 | 2 | Invalid actions (e.g., out‑of‑bounds placement, firing out of turn) are returned as SDK errors with descriptive messages. | implemented-untested | #2 (merged) | -- |
| E5 | US-005 | 0 | The SPA loads with two 6×6 grids side‑by‑side. | implemented-untested | #5 (merged) | -- |
| E5 | US-005 | 1 | Drag‑and‑drop ship placement works before the game starts and updates the board view. | implemented-untested | #5 (merged) | -- |
| E5 | US-005 | 2 | After placement, clicking opponent cells fires shots, updates the view, and respects turn order until a win condition is reached. | implemented-untested | #5 (merged) | -- |
| E5 | US-005 | 3 | When all opponent ships are sunk, a victory modal is displayed. | implemented-untested | #5 (merged) | -- |
| E6 | US-006 | 0 | docker-compose.yml defines three services: frontend, api, mcp, each with its own build context. | implemented-untested | #2 (merged) | -- |
| E6 | US-006 | 1 | Running `docker compose up --build` builds all images and starts containers without errors. | implemented-untested | #2 (merged) | -- |
| E6 | US-006 | 2 | Containers communicate via the internal Docker network; the frontend can reach the API and MCP endpoints. | implemented-untested | #2 (merged) | -- |
| Integration | US-999 | 0 | After `docker compose up`, opening the frontend URL loads the SPA and allows full gameplay: ship placement, turn‑based firing, and victory detection. | implemented-untested | #6 (merged) | -- |
| Integration | US-999 | 1 | The SPA successfully calls the Game API Service for all actions; the MCP server runs and is reachable (though not required for manual play). | implemented-untested | #6 (merged) | -- |
| Integration | US-999 | 2 | Docker logs show successful inter‑service communication and no unhandled exceptions. | implemented-untested | #6 (merged) | -- |
| Integration | US-999 | 3 | An automated Cypress e2e test can complete a full game (place ships, fire shots, win) without page reloads. | implemented-untested | #6 (merged) | -- |

