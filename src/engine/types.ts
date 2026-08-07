export type Direction = 'up' | 'down' | 'left' | 'right' | null;

export interface Position {
  x: number;
  y: number;
}

export interface Entity {
  position: Position;
  // size for collision detection (assuming square)
  size: number;
}

export interface GameState {
  pacMan: Entity & { direction: Direction; mouthOpen: boolean };
  ghosts: Entity[];
  dots: Entity[];
  fruits: Entity[];
  walls: Entity[]; // walls as solid squares for simplicity
  score: number;
  lives: number;
  // other fields as needed
}
