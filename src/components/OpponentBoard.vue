<template>
  <div class="opponent-board">
    <div class="grid" :style="{'--size': size, '--cell-size': `${cellSize}px`}">
      <div
        v-for="cell in cells"
        :key="cell.id"
        class="cell"
        :data-cell="cell.id"
        role="button"
        :aria-label="`Fire at ${cell.x}, ${cell.y}`"
        :tabindex="0"
        @click="onCellClick(cell)"
        @keydown.enter="onCellClick(cell)"
        @keydown.space.prevent="onCellClick(cell)"
      >
        {{ cell.label }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineProps, defineEmits } from 'vue';

interface Cell {
  id: string;
  x: number;
  y: number;
  label: string;
}

const props = defineProps({
  size: {
    type: Number,
    default: 10,
    validator: (value: number) => Number.isInteger(value) && value > 0 && value <= 20,
  },
  cellSize: {
    type: Number,
    default: 30,
    validator: (value: number) => Number.isInteger(value) && value > 0 && value <= 100,
  },
});
const emit = defineEmits<{
  (e: 'fire', payload: { x: number; y: number }): void;
}>();

// Generate a flat list of cells for the board
const cells = computed(() => {
  const arr: Cell[] = [];
  for (let y = 0; y < props.size; y++) {
    for (let x = 0; x < props.size; x++) {
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

import { ref } from 'vue';

const firedCells = ref<Set<string>>(new Set());

function onCellClick(cell: Cell) {
  if (firedCells.value.has(cell.id)) {
    return; // ignore duplicate clicks
  }
  firedCells.value.add(cell.id);
  emit('fire', { x: cell.x, y: cell.y });
}
</script>

<style scoped>
.opponent-board {
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
  width: var(--cell-size);
  height: var(--cell-size);
  background: #f0f0f0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  cursor: pointer;
}
</style>
