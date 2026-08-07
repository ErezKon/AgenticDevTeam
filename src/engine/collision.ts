import { GameState, Entity, Direction } from './types';

/**
 * Checks if two square entities intersect.
 */
export function isColliding(a: Entity, b: Entity): boolean {
  return (
    a.position.x < b.position.x + b.size &&
    a.position.x + a.size > b.position.x &&
    a.position.y < b.position.y + b.size &&
    a.position.y + a.size > b.position.y
  );
}

/**
 * Determines the next position of Pac-Man based on its current direction.
 */
export function getNextPosition(state: GameState): { x: number; y: number } {
  const { pacMan } = state;
  const speed = 1; // one unit per tick for simplicity
  let { x, y } = pacMan.position;
  switch (pacMan.direction) {
    case 'up':
      y -= speed;
      break;
    case 'down':
      y += speed;
      break;
    case 'left':
      x -= speed;
      break;
    case 'right':
      x += speed;
      break;
    default:
      break;
  }
  return { x, y };
}
