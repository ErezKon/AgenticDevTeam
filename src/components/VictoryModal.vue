<template>
  <div class="modal-overlay" @click.self="close">
    <div class="modal-content">
      <h2>Game Over</h2>
      <p v-if="winner">Winner: {{ winner }}</p>
      <button @click="restart">Play Again</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineProps, defineEmits } from 'vue';

const props = defineProps({
  winner: { type: String, required: false },
});

const emit = defineEmits(['restart', 'close']);

function restart() {
  emit('restart');
}
function close() {
  emit('close');
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal-content {
  background: white;
  padding: 2rem;
  border-radius: 8px;
  text-align: center;
}
</style>
