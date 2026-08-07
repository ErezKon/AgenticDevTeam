import { setActivePinia, createPinia } from 'pinia';
import { useGameStore } from '../../store';

describe('Game Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('adds ships correctly', () => {
    const store = useGameStore();
    const ship = { coordinates: [{ x: 0, y: 0 }, { x: 0, y: 1 }] };
    store.addShip(ship);
    expect(store.ships).toHaveLength(1);
    expect(store.ships[0]).toEqual(ship);
  });

  it('detects win when hit result is win and all ship cells are hit', () => {
    const store = useGameStore();
    const ship = { coordinates: [{ x: 0, y: 0 }, { x: 0, y: 1 }] };
    store.addShip(ship);
    // record hits for both cells with result 'hit'
    store.recordHit({ x: 0, y: 0, result: 'hit' });
    store.recordHit({ x: 0, y: 1, result: 'win' }); // final hit indicates win
    expect(store.winner).toBe('You');
  });

  it('does not set winner if not all ship cells are hit', () => {
    const store = useGameStore();
    const ship = { coordinates: [{ x: 0, y: 0 }, { x: 0, y: 1 }] };
    store.addShip(ship);
    store.recordHit({ x: 0, y: 0, result: 'hit' });
    expect(store.winner).toBeNull();
  });
});
