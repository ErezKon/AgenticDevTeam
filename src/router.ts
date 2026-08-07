import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';
import GameView from './views/Game.vue';
import NotFound from './components/NotFound.vue';

const routes: Array<RouteRecordRaw> = [
  {
    path: '/',
    name: 'Game',
    component: GameView,
  },
  // Catch‑all route for undefined paths
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: NotFound,
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

export default router;
