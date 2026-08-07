import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useGameStore = defineStore('game', () => {
  // State: ships placed, hits, winner
  const ships = ref<Array<{ coordinates: { x: number; y: number }[] }>>([]);
  const hits = ref<Array<{ x: number; y: number; result: string }>>([]);
  const winner = ref<string | null>(null);

  function addShip(ship: { coordinates: { x: number; y: number }[] }) {
    ships.value.push(ship);
  }

  function recordHit(hit: { x: number; y: number; result: string }) {
    hits.value.push(hit);
    // Updated win detection: when all ship cells have been hit, declare winner.
    const totalShipCells = ships.value.reduce((sum, ship) => sum + ship.coordinates.length, 0);
    const hitCount = hits.value.filter(h => h.result === 'hit' || h.result === 'win').length;
    if (totalShipCells > 0 && hitCount >= totalShipCells) {
      winner.value = 'You';
    }
  }

  return { ships, hits, winner, addShip, recordHit };
});
