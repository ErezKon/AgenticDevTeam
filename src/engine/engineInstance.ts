import GameEngine from './GameEngine';
import { GameState } from './types';

// Define a basic initial game state
const initialState: GameState = {
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

const gameEngine = new GameEngine(initialState);

export default gameEngine;
