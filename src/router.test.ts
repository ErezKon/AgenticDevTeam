import { expect, test } from 'vitest';
import router from './router';

test('router has a route for the game view', () => {
  const route = router.getRoutes().find(r => r.name === 'Game');
  expect(route).toBeDefined();
  // Verify basic route properties.
  expect(route?.path).toBe('/');
});

test('router includes NotFound catch‑all route', () => {
  const notFound = router.getRoutes().find(r => r.name === 'NotFound');
  expect(notFound).toBeDefined();
  expect(notFound?.path).toBe('/:pathMatch(.*)*');
});

test('router resolves unknown path to NotFound component', () => {
  const resolved = router.resolve({ path: '/some/unknown/path' });
  // The resolved route should match the NotFound route name
  expect(resolved.name).toBe('NotFound');
});
