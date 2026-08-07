<template>
  <div class="player-board">
    <div class="grid" :style="{'--size': props.size}">
      <div
        v-for="cell in cells"
        :key="cell.id"
        class="cell"
        :class="{ ship: shipCellSet.has(cell.id) }"
        :data-cell="cell.id"
        @click="onCellClick(cell)"
      >
        {{ cell.label }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, defineProps, defineEmits } from 'vue';

interface Cell {
  id: string;
  x: number;
  y: number;
  hasShip: boolean;
  label: string;
}

const props = defineProps({
  size: {
    type: Number,
    required: true,
    validator: (v: number) => Number.isInteger(v) && v > 0 && v <= 20,
  },
}); // board size (e.g., 10)
const emit = defineEmits<{
  (e: 'place-ship', payload: { coordinates: { x: number; y: number }[] }): void;
  (e: 'invalid-placement', payload: { message: string }): void;
}>();

const shipCells = ref<Set<string>>(new Set());
const shipCellSet = computed(() => shipCells.value);

const cells = computed(() => {
  const arr: Cell[] = [];
  for (let y = 0; y < props.size; y++) {
    for (let x = 0; x < props.size; x++) {
      arr.push({
        id: `${x}-${y}`,
        x,
        y,
        hasShip: false,
        label: `${x},${y}`,
      });
    }
  }
  return arr;
});

// Simple ship placement logic: click two cells to define a ship (start & end)
const selected = ref<Cell[]>([]);

function onCellClick(cell: Cell) {
  // Prevent duplicate selection of the same cell
  if (selected.value.some((c) => c.id === cell.id)) {
    emit('invalid-placement', { message: 'Duplicate cell selection is not allowed' });
    selected.value = [];
    return;
  }

  if (selected.value.length < 2) {
    selected.value.push(cell);
    if (selected.value.length === 2) {
      const [start, end] = selected.value;
      const coordinates = generateCoordinates(start, end);
      // Validate generated coordinates are within board bounds
      const outOfBounds = coordinates.some(coord => coord.x < 0 || coord.y < 0 || coord.x >= props.size || coord.y >= props.size);
      if (outOfBounds) {
        emit('invalid-placement', { message: 'Ship placement out of board bounds' });
        selected.value = [];
        return;
      }
      // Enforce maximum ship length (e.g., 5 cells)
      const MAX_SHIP_LENGTH = 5;
      if (coordinates.length > MAX_SHIP_LENGTH) {
        emit('invalid-placement', { message: `Ship length exceeds maximum of ${MAX_SHIP_LENGTH}` });
        selected.value = [];
        return;
      }
      if (coordinates.length > 0) {
        // Validate overlap with existing ships
        const overlap = coordinates.some(coord => shipCells.value.has(`${coord.x}-${coord.y}`));
        if (overlap) {
          emit('invalid-placement', { message: 'Ship placement overlaps existing ship' });
          selected.value = [];
          return;
        }
        emit('place-ship', { coordinates });
        // Update shipCells set for UI feedback
        coordinates.forEach((coord) => {
          const cellId = `${coord.x}-${coord.y}`;
          shipCells.value = new Set([...shipCells.value, cellId]);
        });
      }
      // Reset selection after handling
      selected.value = [];
    }
  }
}


function generateCoordinates(start: Cell, end: Cell) {
  const coords: { x: number; y: number }[] = [];
  if (start.x === end.x) {
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    for (let y = minY; y <= maxY; y++) {
      coords.push({ x: start.x, y });
    }
  } else if (start.y === end.y) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    for (let x = minX; x <= maxX; x++) {
      coords.push({ x, y: start.y });
    }
  } else {
    // diagonal not allowed – emit validation event instead of silent fallback
    emit('invalid-placement', { message: 'Diagonal placement is not allowed' });
    return [];
  }
  return coords;
}
</script>

<style scoped>
.player-board {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.grid {
  display: grid;
  grid-template-columns: repeat(var(--size), 30px);
  gap: 2px;
}
.cell {
  width: 30px;
  height: 30px;
  background: #e0e0e0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  cursor: pointer;
}
.cell.ship {
  background: #4caf50;
}
</style>
