# Product Manager Mission Report

**Agent**: product-manager  
**Generated**: 2026-08-13T09:06:35.781Z

---

## User Stories (7)

### US-001: As a player, I want the game to run smoothly with Pac-Man, ghosts, fruit, and maze rendered
- So that: I can play the classic Pac-Man experience
- AC: GameLoop updates at a fixed 60 fps timestep without frame drops.; Canvas correctly renders the maze layout, Pac-Man, all ghosts, and fruit according to the current GameState.; HUD displays the current score and lives in sync with the underlying ScoreManager.; No visual artifacts appear when entities move or change direction.
### US-002: As a player, I want to control Pac-Man via keyboard, touch swipe, and on‑screen buttons
- So that: I can play on any device comfortably
- AC: Arrow keys and WASD move Pac‑Man in the intended direction and stop at walls.; Swipe gestures on touch devices are translated into the correct directional commands.; On‑screen directional buttons respond to clicks/taps and move Pac‑Man accordingly.; Input handling respects the game pause state and does not affect UI navigation.
### US-003: As a player, I want ghosts to exhibit distinct personalities and chase/scatter behavior
- So that: the gameplay feels authentic and challenging
- AC: Each ghost follows its personality-specific target algorithm (chase, ambush, flank, random).; Ghosts alternate between chase and scatter modes according to the defined timers.; When Pac‑Man eats a power pellet, all ghosts enter frightened mode, reverse direction, and move at reduced speed.; Eaten ghosts turn into eyes, return to the ghost house, and respawn correctly after reaching it.
### US-004: As a player, I want my score, lives, extra lives, and high‑score list to be tracked and saved
- So that: I can see my progress across sessions
- AC: Score increments correctly for dots, power pellets, ghosts, and fruit, and displays in the HUD.; An extra life is awarded automatically when the score reaches 10,000 points.; Lives decrement on Pac‑Man death and the game ends after the last life is lost.; The top‑10 high‑score list persists in localStorage and is shown on the Start Screen.
### US-005: As a player, I want sound effects and background music with mute control
- So that: the game feels immersive without being intrusive
- AC: All defined sound effects play at the correct game events (dot, pellet, ghost eaten, death, fruit, extra life).; The background siren loops continuously and its pitch increases as fewer dots remain.; A mute toggle in the UI instantly silences all audio and restores it when un‑muted.; Audio assets load without causing frame‑rate drops or stutters.
### US-006: As a user, I want to play the game offline after the first load
- So that: I can enjoy the game without an internet connection
- AC: A Service Worker caches all static assets (HTML, JS, CSS, images, audio) on the first visit.; When the network is unavailable, the game loads and runs fully from the cache.; All gameplay features (input, audio, scoring) work correctly while offline.
### US-007: As a player, I want all game components to be wired together in the main application loop
- So that: the game is playable from start to finish as a cohesive experience
- AC: Launching the app shows the Start Screen, then transitions through countdown, gameplay, pause, level complete, and Game Over screens without errors.; InputHandler commands affect Pac‑Man movement, GameLoop updates entities, ScoreManager updates the HUD, and AudioManager plays sounds in response to events.; The application runs end‑to‑end at 60 fps with no uncaught exceptions.; The Service Worker serves the cached version when offline, confirming full integration.

## Tasks (36)

- **TASK-001** [backend/TypeScript, Vite] Implement fixed‑timestep GameLoop
- **TASK-002** [frontend/Canvas API, TypeScript] Canvas rendering of Maze, Pac‑Man, Ghosts, and Fruit
- **TASK-003** [frontend/Preact, TypeScript] HUD integration with ScoreManager
- **TASK-004** [testing/Vitest] Unit tests for GameLoop and entity updates
- **TASK-005** [testing/Playwright] E2E test: start game and eat first dot
- **TASK-006** [backend/TypeScript] Add WASD key support to InputHandler
- **TASK-007** [frontend/TypeScript, Preact] Implement touch swipe detection
- **TASK-008** [frontend/Preact, TypeScript] On‑screen directional button component
- **TASK-009** [frontend/Preact, CSS] Keyboard‑only accessibility for menus
- **TASK-010** [testing/Vitest] Unit tests for InputHandler mappings
- **TASK-011** [backend/TypeScript] GhostAI personality target algorithms
- **TASK-012** [backend/TypeScript] Ghost mode timers and state transitions
- **TASK-013** [backend/TypeScript] Frightened mode behavior
- **TASK-014** [backend/TypeScript] Eyes‑only return state for eaten ghosts
- **TASK-015** [testing/Vitest] Unit tests for GhostAI and mode logic
- **TASK-016** [backend/TypeScript] Enhance ScoreManager with extra lives and persistence
- **TASK-017** [frontend/Preact, TypeScript] High‑score entry UI on Game Over
- **TASK-018** [backend/TypeScript] Persist and validate high‑score data
- **TASK-019** [testing/Vitest] Unit tests for ScoreManager logic
- **TASK-020** [testing/Playwright] E2E test: high‑score entry flow
- **TASK-021** [backend/TypeScript, tiny-audio library] AudioManager asset loading and playback
- **TASK-022** [frontend/Preact, TypeScript] Mute toggle UI integration
- **TASK-023** [backend/Web Audio API, TypeScript] Background siren with pitch adjustment
- **TASK-024** [testing/Vitest] Unit tests for AudioManager mute and playback
- **TASK-025** [testing/Playwright] Performance test: audio impact on frame rate
- **TASK-026** [infra/Workbox, Vite plugin] Configure Workbox Service Worker generation
- **TASK-027** [frontend/Preact, TypeScript] Offline fallback UI
- **TASK-028** [testing/Playwright] E2E offline loading test
- **TASK-029** [infra/GitHub Actions] CI workflow step for Service Worker verification
- **TASK-030** [infra/Preact, TypeScript] Bootstrap application and wire core services
- **TASK-031** [backend/TypeScript] Event propagation between GameLoop, ScoreManager, and AudioManager
- **TASK-032** [infra/TypeScript] Asset loading error handling and fallback
- **TASK-033** [testing/Playwright] Full game flow E2E test
- **TASK-034** [infra/npm/yarn, Vite] Project initialization with Vite, Preact, and TypeScript
- **TASK-035** [infra/GitHub Actions] Configure GitHub Actions CI pipeline
- **TASK-036** [infra/ESLint, Prettier, lint-staged] Set up ESLint and Prettier for code quality
