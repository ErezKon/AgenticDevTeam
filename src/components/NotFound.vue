<template>
  <div class="not-found">
    <h1>404 - Not Found</h1>
    <p>The page you are looking for does not exist.</p>
    <router-link to="/">Return to Game</router-link>
  </div>
</template>

<script setup lang="ts">
// No script needed
</script>

<style scoped>
.not-found {
  text-align: center;
  margin-top: 2rem;
}
</style>
