<template>
  <div id="app">
    <PlayerBoard :size="10" @place-ship="onPlaceShip" />
  </div>
</template>

<script setup lang="ts">
import PlayerBoard from './components/PlayerBoard.vue';

function onPlaceShip(payload: { coordinates: { x: number; y: number }[] }) {
  console.log('Ship placed:', payload.coordinates);
}
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  text-align: center;
  margin-top: 60px;
}
</style>
