# Vue Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - 1.1 [Naming Conventions](#11-naming-conventions)
   - 1.2 [Single-File Component Order](#12-single-file-component-order)
   - 1.3 [Template Attribute Order](#13-template-attribute-order)
2. [Composition API (Recommended)](#2-composition-api-recommended)
3. [Component Design](#3-component-design)
4. [Reactivity](#4-reactivity)
5. [State Management (Pinia)](#5-state-management-pinia)
6. [Routing](#6-routing)
7. [Template Best Practices](#7-template-best-practices)
8. [Performance](#8-performance)
9. [Testing](#9-testing)
10. [Accessibility (a11y)](#10-accessibility-a11y)
11. [Internationalization (i18n)](#11-internationalization-i18n)

---

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Component (SFC) | PascalCase file | `UserCard.vue` |
| Component (in template) | PascalCase or kebab-case | `<UserCard />` or `<user-card />` |
| Base/UI component | `Base` prefix | `BaseButton.vue`, `BaseInput.vue` |
| Layout component | `Layout` prefix or folder | `LayoutDefault.vue` |
| Page/View component | `View` suffix or `views/` dir | `DashboardView.vue` |
| Single-instance component | `The` prefix | `TheNavbar.vue`, `TheSidebar.vue` |
| Composable | `use` prefix camelCase | `useAuth`, `useSearch` |
| Composable file | `use` prefix camelCase | `useAuth.ts` |
| Store (Pinia) | `use` prefix + `Store` | `useUserStore` |
| Prop | camelCase (JS) / kebab-case (template) | `userName` / `user-name` |
| Event (emit) | kebab-case | `'item-selected'`, `'form-submitted'` |
| Provide/Inject key | Symbol or UPPER_SNAKE_CASE | `THEME_KEY` |
| Directive | `v-` prefix kebab-case | `v-focus`, `v-click-outside` |
| File name | PascalCase | `UserCard.vue`, `useAuth.ts` |

### 1.2 Single-File Component Order

```vue
<!-- Recommended SFC order -->

<!-- 1. Script (logic first -- Composition API with script setup) -->
<script setup lang="ts">
// 1a. Type imports
import type { User } from '@/types';

// 1b. Vue imports
import { ref, computed, onMounted, watch } from 'vue';

// 1c. External imports
import { useRoute } from 'vue-router';

// 1d. Internal imports
import { useUserStore } from '@/stores/user';
import UserAvatar from '@/components/UserAvatar.vue';
import { formatDate } from '@/utils/date';

// 1e. Props
const props = withDefaults(defineProps<{
  userId: string;
  showActions?: boolean;
}>(), {
  showActions: true,
});

// 1f. Emits
const emit = defineEmits<{
  selected: [user: User];
  deleted: [userId: string];
}>();

// 1g. Composables / Store
const route = useRoute();
const userStore = useUserStore();

// 1h. Refs (reactive state)
const isLoading = ref(false);
const searchQuery = ref('');

// 1i. Computed
const filteredUsers = computed(() =>
  userStore.users.filter((u) =>
    u.name.toLowerCase().includes(searchQuery.value.toLowerCase())
  )
);

// 1j. Watchers
watch(
  () => props.userId,
  async (newId) => {
    await loadUser(newId);
  }
);

// 1k. Lifecycle hooks
onMounted(async () => {
  await loadUser(props.userId);
});

// 1l. Methods
async function loadUser(id: string): Promise<void> {
  isLoading.value = true;
  try {
    await userStore.fetchUser(id);
  } finally {
    isLoading.value = false;
  }
}

function handleSelect(user: User): void {
  emit('selected', user);
}
</script>

<!-- 2. Template -->
<template>
  <div class="user-card">
    <UserAvatar :user="userStore.currentUser" />
    <h2>{{ userStore.currentUser?.name }}</h2>
    <button v-if="showActions" @click="handleSelect(userStore.currentUser!)">
      Select
    </button>
  </div>
</template>

<!-- 3. Styles (scoped) -->
<style scoped lang="scss">
.user-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  border-radius: 8px;
}
</style>
```

### 1.3 Template Attribute Order

```html
<!-- Consistent attribute ordering -->
<MyComponent
  v-if="isVisible"
  v-for="item in items"
  :key="item.id"
  ref="myRef"
  is="component-name"
  v-model="value"
  class="base-class"
  :class="{ active: isActive }"
  :style="customStyle"
  :prop-a="valueA"
  :prop-b="valueB"
  v-bind="$attrs"
  @click="handleClick"
  @custom-event="handleCustom"
  v-on="$listeners"
  v-custom-directive
/>

<!-- Order:
  1. Definition (is)
  2. List rendering (v-for)
  3. Conditionals (v-if, v-else-if, v-else, v-show)
  4. Render modifiers (v-once, v-pre)
  5. Global awareness (id)
  6. Unique attributes (ref, key)
  7. Two-way binding (v-model)
  8. Static attributes (class, style)
  9. Dynamic attributes (:class, :style)
  10. Other bindings (:prop)
  11. Events (@event)
  12. Content (v-html, v-text)
-->
```

## 2. Composition API (Recommended)

- Prefer the **Composition API** with `<script setup>` for new projects.
- Organize code by **logical concern**, not by option type.
- Extract reusable logic into **composables** (prefixed with `use`).

## 3. Component Design

- Use **single-file components** (`.vue` files).
- Use **PascalCase** for component names in templates and imports.
- Keep components **small** -- extract when complexity grows.
- Use **`defineProps`** and **`defineEmits`** with TypeScript generics.
- Props should be as **specific** as possible.

## 4. Reactivity

- Use **`ref`** for primitives and **`reactive`** for objects.
- Avoid destructuring **`reactive`** objects directly (breaks reactivity); use **`toRefs`**.
- Use **`computed`** for derived state.
- Use **`watch`** and **`watchEffect`** for side effects on reactive data.
- Avoid mutating **props**; emit events to the parent.

```typescript
// Composable example
export function useSearch<T>(
  items: Ref<T[]>,
  searchFn: (item: T, query: string) => boolean,
) {
  const query = ref('');

  const filteredItems = computed(() =>
    query.value
      ? items.value.filter((item) => searchFn(item, query.value))
      : items.value
  );

  return { query, filteredItems };
}
```

## 5. State Management (Pinia)

- Use **Pinia** (official recommendation) over Vuex.
- Create **one store per domain/feature**.
- Use **`storeToRefs()`** to maintain reactivity when destructuring.
- Define stores using the **setup syntax** for full Composition API power.

```typescript
export const useUserStore = defineStore('user', () => {
  const users = ref<User[]>([]);
  const currentUser = ref<User | null>(null);

  const activeUsers = computed(() =>
    users.value.filter((u) => u.isActive)
  );

  async function fetchUsers() {
    users.value = await userService.getAll();
  }

  return { users, currentUser, activeUsers, fetchUsers };
});
```

## 6. Routing

- Use **lazy loading** for route components.
- Implement **navigation guards** for authentication and authorization.
- Use **named routes** for maintainability.

```typescript
const routes: RouteRecordRaw[] = [
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { requiresAuth: true },
  },
];
```

## 7. Template Best Practices

- Use **`v-for`** with **`:key`** always -- use stable, unique identifiers.
- Never use **`v-for`** and **`v-if`** on the same element.
- Prefer **`v-show`** for frequently toggled elements; **`v-if`** for conditional blocks.

## 8. Performance

- Use **`defineAsyncComponent`** for lazy-loaded components.
- Use **`v-once`** for static content that never changes.
- Use **`v-memo`** for expensive list rendering (Vue 3.2+).
- Use **`shallowRef`** / **`shallowReactive`** for large objects.

## 9. Testing

- Use **Vitest** + **Vue Test Utils** for unit/component tests.
- Test **component behavior**, not internal implementation.
- Use **Cypress** or **Playwright** for end-to-end tests.

## 10. Accessibility (a11y)

- Use **semantic HTML** elements in templates (`<button>`, `<nav>`, `<main>`).
- Add **`aria-*`** attributes for dynamic content and custom components.
- Ensure all interactive elements are **keyboard-navigable**.
- Use **`vue-axe`** in development for automated accessibility auditing.
- Manage focus with **template refs** (`ref="myInput"`) and `$refs.myInput.focus()`.
- Use **`role`** attributes for custom widgets and **`aria-live`** for dynamic updates.

```vue
<template>
  <div>
    <label :for="inputId">Search</label>
    <input
      :id="inputId"
      v-model="query"
      type="search"
      :aria-describedby="helpId"
    />
    <p :id="helpId" class="help-text">Enter a name to search</p>

    <div role="status" aria-live="polite">
      {{ resultCount }} results found
    </div>
  </div>
</template>
```

## 11. Internationalization (i18n)

- Use **`vue-i18n`** for runtime translations.
- Organize translations by **locale** and **feature/namespace**.
- Use **lazy loading** for locale messages to reduce initial bundle size.
- Support **pluralization** and **date/number formatting** through vue-i18n.
- Store locale files in a dedicated **`locales/`** directory.

```typescript
// i18n setup
import { createI18n } from 'vue-i18n';

const i18n = createI18n({
  locale: 'en',
  fallbackLocale: 'en',
  messages: {
    en: { user: { greeting: 'Hello, {name}!' } },
    fr: { user: { greeting: 'Bonjour, {name} !' } },
  },
});
```

```vue
<template>
  <p>{{ $t('user.greeting', { name: user.name }) }}</p>
</template>
```

---
