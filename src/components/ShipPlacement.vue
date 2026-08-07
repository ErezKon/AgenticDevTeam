<template>
  <div class="ship-placement">
    <div class="controls">
      <span>Select ship size:</span>
      <button
        v-for="size in shipSizes"
        :key="size"
        :class="{ selected: selectedShipSize === size }"
        @click="selectShipSize(size)"
        data-test="size-button"
      >
        {{ size }}
      </button>
    </div>
    <div class="grid" :style="{'--size': boardSize}">
      <div
        v-for="cell in cells"
        :key="cell.id"
        class="cell"
        :class="{ ship: shipCellSet.has(cell.id), pending: pendingCellIds.has(cell.id) }"
        :data-cell="cell.id"
        @click="onCellClick(cell)"
      >
        {{ cell.label }}
      </div>
    </div>
    <div v-if="errorMessage" class="error" data-test="error-msg">{{ errorMessage }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, defineEmits } from 'vue';
import { placeShip, type Coordinate } from '@/services/api';

// Emits for parent components (optional, but kept for consistency)
const emit = defineEmits<{
  (e: 'placement-success', payload: { coordinates: Coordinate[] }): void;
  (e: 'placement-failure', payload: { message: string }): void;
}>();

// Board configuration – 6x6 as per story
const boardSize = 6;

interface Cell {
  id: string;
  x: number;
  y: number;
  label: string;
}

// Reactive state
const shipSizes = [2, 3, 4];
const selectedShipSize = ref<number | null>(null);
const selectedCells = ref<Cell[]>([]);
const shipCells = ref<Set<string>>(new Set()); // confirmed placed ships
const pendingCellIds = ref<Set<string>>(new Set()); // cells of the ship currently being placed
const errorMessage = ref<string>('');

const shipCellSet = computed(() => shipCells.value);

// Generate flat list of cells for the grid
const cells = computed(() => {
  const arr: Cell[] = [];
  for (let y = 0; y < boardSize; y++) {
    for (let x = 0; x < boardSize; x++) {
      arr.push({
        id: `${x}-${y}`,
        x,
        y,
        label: `${x},${y}`,
      });
    }
  }
  return arr;
});

function selectShipSize(size: number) {
  selectedShipSize.value = size;
  // Reset any in‑progress selection when size changes
  selectedCells.value = [];
  pendingCellIds.value.clear();
  errorMessage.value = '';
}

function onCellClick(cell: Cell) {
  if (!selectedShipSize.value) {
    errorMessage.value = 'Please select a ship size first.';
    return;
  }
  // Allow selecting cells even if they already contain a ship; overlap will be validated later
  // Record selection (max two cells: start & end)
  if (selectedCells.value.length < 2) {
    selectedCells.value.push(cell);
    if (selectedCells.value.length === 2) {
      handlePlacement();
    }
  }
}

function handlePlacement() {
  const [start, end] = selectedCells.value;
  const generated = generateCoordinates(start, end);
  // Validate generated coordinates
  if (generated.length === 0) {
    // generateCoordinates already set errorMessage for diagonal case
    resetSelection();
    return;
  }
  // Ensure length matches selected ship size
  if (generated.length !== selectedShipSize.value) {
    errorMessage.value = `Selected ship size ${selectedShipSize.value} does not match placement length ${generated.length}`;
    resetSelection();
    return;
  }
  // Overlap check with already placed ships
  const overlap = generated.some(coord => shipCellSet.value.has(`${coord.x}-${coord.y}`));
  if (overlap) {
    errorMessage.value = 'Ship placement overlaps an existing ship.';
    resetSelection();
    return;
  }
  // Visual pending highlight
  pendingCellIds.value = new Set(generated.map(c => `${c.x}-${c.y}`));
  // Call backend API
  placeShip({ size: selectedShipSize.value as number, coordinates: generated })
    .then(() => {
      // On success, commit to shipCells and emit success
      generated.forEach(coord => shipCells.value.add(`${coord.x}-${coord.y}`));
      emit('placement-success', { coordinates: generated });
      errorMessage.value = '';
    })
    .catch((err: Error) => {
      errorMessage.value = err.message || 'Failed to place ship';
      emit('placement-failure', { message: errorMessage.value });
    })
    .finally(() => {
      // Clean up temporary state regardless of outcome
      pendingCellIds.value.clear();
      resetSelection();
    });
}

function resetSelection() {
  selectedCells.value = [];
}

function generateCoordinates(start: Cell, end: Cell): Coordinate[] {
  const coords: Coordinate[] = [];
  if (start.x === end.x) {
    // vertical placement
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    for (let y = minY; y <= maxY; y++) {
      coords.push({ x: start.x, y });
    }
  } else if (start.y === end.y) {
    // horizontal placement
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    for (let x = minX; x <= maxX; x++) {
      coords.push({ x, y: start.y });
    }
  } else {
    errorMessage.value = 'Diagonal placement is not allowed';
    return [];
  }
  // Ensure all coordinates are within board bounds
  const outOfBounds = coords.some(c => c.x < 0 || c.y < 0 || c.x >= boardSize || c.y >= boardSize);
  if (outOfBounds) {
    errorMessage.value = 'Ship placement out of board bounds';
    return [];
  }
  return coords;
}
</script>

<style scoped>
.ship-placement {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.controls {
  margin-bottom: 1rem;
}
.controls button {
  margin: 0 0.25rem;
  padding: 0.5rem 1rem;
}
.controls button.selected {
  background-color: #1976d2;
  color: white;
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
.cell.pending {
  background: #ffeb3b;
}
.error {
  margin-top: 1rem;
  color: #d32f2f;
}
</style>
