import { GameState, Entity } from './types';
import { isColliding, getNextPosition } from './collision';

type Listener = (state: GameState) => void;

/**
 * Simple GameEngine singleton that holds the game state, runs the tick loop,
 * performs collision detection and notifies subscribers.
 */
class GameEngine {
  private state: GameState;
  private listeners: Listener[] = [];
  private tickCount = 0;

  constructor(initialState: GameState) {
    this.state = initialState;
  }

  /** Subscribe to state updates */
  subscribe(fn: Listener) {
    this.listeners.push(fn);
    // Immediately invoke with current state
    fn(this.state);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  /** Get current state */
  getState(): GameState {
    return this.state;
  }

  /** Run a single tick – update positions, handle collisions, animate mouth */
  tick() {
    this.tickCount++;
    const { pacMan } = this.state;
    // Determine next position based on direction
    const nextPos = getNextPosition(this.state);
    const nextEntity: Entity = { position: nextPos, size: pacMan.size } as Entity;

    // Wall collision – if collides, stay in place
    const wallCollision = this.state.walls.some(w => isColliding(nextEntity, w));
    if (!wallCollision) {
      pacMan.position = nextPos;
    }

    // Dot collision – consume dot, increase score
    const dotIndex = this.state.dots.findIndex(d => isColliding(pacMan, d));
    if (dotIndex !== -1) {
      this.state.dots.splice(dotIndex, 1);
      this.state.score += 10; // each dot worth 10 points
    }

    // Fruit collision – consume fruit, increase score
    const fruitIndex = this.state.fruits.findIndex(f => isColliding(pacMan, f));
    if (fruitIndex !== -1) {
      this.state.fruits.splice(fruitIndex, 1);
      this.state.score += 100; // each fruit worth 100 points
    }

    // Ghost collision – lose a life (simple logic, no respawn handling)
    const ghostCollision = this.state.ghosts.some(g => isColliding(pacMan, g));
    if (ghostCollision) {
      this.state.lives = Math.max(this.state.lives - 1, 0);
    }

    // Mouth animation – toggle every 5 ticks for smoother animation
    if (this.tickCount % 5 === 0) {
      pacMan.mouthOpen = !pacMan.mouthOpen;
    }

    this.notify();
  }

  private notify() {
    this.listeners.forEach(fn => fn(this.state));
  }
}

export default GameEngine;
