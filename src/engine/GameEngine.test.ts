import GameEngine from './GameEngine';
import { GameState, Entity, Direction } from './types';

describe('GameEngine tick logic', () => {
  const createEngine = (overrides?: Partial<GameState>) => {
    const defaultState: GameState = {
      pacMan: {
        position: { x: 0, y: 0 },
        size: 20,
        direction: null,
        mouthOpen: false,
      },
      ghosts: [],
      dots: [],
      fruits: [],
      walls: [],
      score: 0,
      lives: 3,
    };
    const state = { ...defaultState, ...overrides } as GameState;
    return new GameEngine(state);
  };

  test('pac‑man moves in the set direction when no wall', () => {
    const engine = createEngine({ pacMan: { position: { x: 0, y: 0 }, size: 20, direction: 'right' as Direction, mouthOpen: false } });
    engine.tick();
    const { pacMan } = engine.getState();
    expect(pacMan.position).toEqual({ x: 1, y: 0 });
  });

  test('pac‑man does not move through a wall', () => {
    const wall: Entity = { position: { x: 1, y: 0 }, size: 20 };
    const engine = createEngine({
      pacMan: { position: { x: 0, y: 0 }, size: 20, direction: 'right' as Direction, mouthOpen: false },
      walls: [wall],
    });
    engine.tick();
    const { pacMan } = engine.getState();
    // should stay at original position because wall blocks movement
    expect(pacMan.position).toEqual({ x: 0, y: 0 });
  });

  test('pac‑man consumes a dot and gains score', () => {
    const dot: Entity = { position: { x: 0, y: 0 }, size: 20 };
    const engine = createEngine({
      pacMan: { position: { x: 0, y: 0 }, size: 20, direction: null, mouthOpen: false },
      dots: [dot],
    });
    engine.tick();
    const { dots, score } = engine.getState();
    expect(dots).toHaveLength(0);
    expect(score).toBe(10);
  });

  test('pac‑man collides with a ghost and loses a life', () => {
    const ghost: Entity = { position: { x: 0, y: 0 }, size: 20 };
    const engine = createEngine({
      pacMan: { position: { x: 0, y: 0 }, size: 20, direction: null, mouthOpen: false },
      ghosts: [ghost],
      lives: 3,
    });
    engine.tick();
    const { lives } = engine.getState();
    expect(lives).toBe(2);
  });

  test('mouth animation toggles every 5 ticks', () => {
    const engine = createEngine({ pacMan: { position: { x: 0, y: 0 }, size: 20, direction: null, mouthOpen: false } });
    // Run 4 ticks – mouth should stay false
    for (let i = 0; i < 4; i++) {
      engine.tick();
    }
    expect(engine.getState().pacMan.mouthOpen).toBe(false);
    // 5th tick toggles
    engine.tick();
    expect(engine.getState().pacMan.mouthOpen).toBe(true);
    // next 5 ticks toggle back
    for (let i = 0; i < 5; i++) {
      engine.tick();
    }
    expect(engine.getState().pacMan.mouthOpen).toBe(false);
  });
});
