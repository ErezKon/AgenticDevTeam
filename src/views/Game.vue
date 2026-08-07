<template>
  <div class="game-container">
    <PlayerBoard :size="10" @place-ship="onPlaceShip" />
    <OpponentBoard :size="10" @fire="onFire" />
    <VictoryModal v-if="winner" :winner="winner" @restart="onRestart" />
    <div v-if="errorMessage" class="error-message">{{ errorMessage }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PlayerBoard from '../components/PlayerBoard.vue';
import OpponentBoard from '../components/OpponentBoard.vue';
import VictoryModal from '../components/VictoryModal.vue';
import { useGameStore } from '../store';
import { fireShot } from '../services/api';

const store = useGameStore();
const winner = ref<string | null>(null);
const errorMessage = ref<string | null>(null);

function onPlaceShip(payload: { coordinates: { x: number; y: number }[] }) {
  store.addShip({ coordinates: payload.coordinates });
}

const route = useRoute();

async function onFire(payload: { x: number; y: number }) {
  try {
    // Retrieve gameId from route params if available, otherwise use default.
    const route = useRoute();
    const gameId = (route.params.gameId as string) || 'demo-game';
    // fireShot no longer requires gameId; playerId defaults to 1.
    const response = await fireShot({ x: payload.x, y: payload.y });
    // Expect response to contain a `result` field.
    if (!response || typeof response.result !== 'string') {
      throw new Error('Invalid response format from fireShot');
    }
    const result = response.result;
    store.recordHit({ x: payload.x, y: payload.y, result });
    errorMessage.value = null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errorMessage.value = msg;
    console.error('Failed to fire shot:', e);
  }
}

function onRestart() {
  store.$reset();
  winner.value = null;
}

watch(
  () => store.winner,
  (newWinner) => {
    winner.value = newWinner;
  }
);
</script>

<style scoped>
.game-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}
</style>
