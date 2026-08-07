<template>
  <div class="own-board">
    <div class="grid" :style="{'--size': props.size}">
      <div
        v-for="cell in cells"
        :key="cell.id"
        class="cell"
        :class="{
          ship: shipCellSet.has(cell.id),
          hit: hitCellSet.has(cell.id),
          miss: missCellSet.has(cell.id),
        }"
        :data-cell="cell.id"
      >
        {{ cell.label }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, defineProps } from 'vue';
import { getBoard, type Coordinate } from '../services/api';

interface Cell {
  id: string;
  x: number;
  y: number;
  label: string;
}

const props = defineProps({
  size: {
    type: Number,
    required: true,
    validator: (v: number) => Number.isInteger(v) && v > 0 && v <= 20,
  },
  gameId: {
    type: String,
    required: true,
  },
  playerId: {
    type: String,
    required: true,
  },
});

// Reactive sets for UI rendering
const shipCellSet = ref<Set<string>>(new Set());
const hitCellSet = ref<Set<string>>(new Set());
const missCellSet = ref<Set<string>>(new Set());

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

onMounted(async () => {
  try {
    const data = await getBoard(props.gameId, props.playerId);
    // Expected shape: { ships: [{ coordinates: [[x,y], ...] }], hits: [[x,y], ...], misses: [[x,y], ...] }
    if (Array.isArray(data.ships)) {
      data.ships.forEach((ship: any) => {
        if (Array.isArray(ship.coordinates)) {
          ship.coordinates.forEach((coord: Coordinate) => {
            shipCellSet.value = new Set([...shipCellSet.value, `${coord[0]}-${coord[1]}`]);
          });
        }
      });
    }
    if (Array.isArray(data.hits)) {
      data.hits.forEach((coord: Coordinate) => {
        hitCellSet.value.add(`${coord[0]}-${coord[1]}`);
      });
    }
    if (Array.isArray(data.misses)) {
      data.misses.forEach((coord: Coordinate) => {
        missCellSet.value.add(`${coord[0]}-${coord[1]}`);
      });
    }
  } catch (e) {
    console.error('Failed to load board data', e);
  }
});
</script>

<style scoped>
.own-board {
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
}
.cell.ship {
  background: #4caf50;
}
.cell.hit {
  background: #ff5252;
}
.cell.miss {
  background: #90caf9;
}
</style>
