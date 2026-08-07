<template>
  <div id="app">
    <!-- Router view for potential future routes -->
    <router-view />
  </div>
</template>

<script setup lang="ts">
// No direct store interaction here; Game view handles UI state.
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  text-align: center;
  margin-top: 60px;
}
</style>