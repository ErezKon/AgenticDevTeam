# QA Lead — Test Plan

**Agent**: qa-lead  
**Generated**: 2026-08-13T09:07:30.169Z

---

## Test Plan

{
  "scope": "All acceptance criteria are covered; no uncovered criteria.",
  "unit": [
    {
      "target": "TaskForm component renders with empty fields on initial load",
      "description": "Verify that TaskForm shows empty title and description inputs when the app loads.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-001",
      "acIndex": 0,
      "moduleId": "TaskForm"
    },
    {
      "target": "TaskForm validates non‑empty title and calls onSubmit with correct payload",
      "description": "Simulate user entering a title (description optional) and submitting; ensure onSubmit receives a task object with is_done false.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-001",
      "acIndex": 1,
      "moduleId": "TaskForm"
    },
    {
      "target": "TaskItem edit button opens TaskForm pre‑filled with task data",
      "description": "Click the edit button on a TaskItem and assert that TaskForm receives the current title and description as initial values.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-002",
      "acIndex": 0,
      "moduleId": "TaskItem"
    },
    {
      "target": "TaskForm submission after edit updates the task in the list",
      "description": "After editing a task via TaskForm, verify that the TaskItem displays the updated title and description.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-002",
      "acIndex": 1,
      "moduleId": "TaskForm"
    },
    {
      "target": "TaskItem delete button removes task from UI list",
      "description": "Click the delete button on a TaskItem and assert that the item is no longer rendered.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-003",
      "acIndex": 0,
      "moduleId": "TaskItem"
    },
    {
      "target": "TaskItem checkbox toggles is_done state",
      "description": "Interact with the task checkbox and verify that the underlying task object's is_done flag flips.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-004",
      "acIndex": 0,
      "moduleId": "TaskItem"
    },
    {
      "target": "TaskItem visual style changes when task is marked done",
      "description": "After toggling a task to done, check that the DOM element receives the CSS class that applies strikethrough/faded styling.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-004",
      "acIndex": 1,
      "moduleId": "TaskItem"
    },
    {
      "target": "StorageService.saveTasks handles quota exceeded error",
      "description": "Mock localStorage.setItem to throw a QUOTA_EXCEEDED_ERR and verify that StorageService returns a user‑friendly error message.",
      "framework": "Vitest",
      "storyId": "US-005",
      "acIndex": 2,
      "moduleId": "StorageService"
    },
    {
      "target": "StorageService.loadTasks returns empty array when no data exists",
      "description": "Ensure that loadTasks gracefully returns [] if localStorage key is missing or malformed.",
      "framework": "Vitest",
      "storyId": "US-005",
      "acIndex": 0,
      "moduleId": "StorageService"
    },
    {
      "target": "App initializes state from StorageService on mount",
      "description": "Mount the App component and assert that it calls StorageService.loadTasks and renders the returned tasks.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-005",
      "acIndex": 0,
      "moduleId": "App"
    },
    {
      "target": "All interactive elements have correct ARIA attributes",
      "description": "Render each component and check that buttons, inputs, and checkboxes include appropriate aria-labels/roles.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-007",
      "acIndex": 0,
      "moduleId": "TaskItem"
    },
    {
      "target": "Keyboard navigation works for TaskForm controls",
      "description": "Simulate Tab/Enter/Space navigation through TaskForm fields and buttons, ensuring each can be focused and activated via keyboard.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-007",
      "acIndex": 1,
      "moduleId": "TaskForm"
    }
  ],
  "integration": [
    {
      "target": "Create task flow persists to localStorage",
      "description": "Render App, submit a new task via TaskForm, then verify localStorage contains the serialized task and that a page reload (re‑mount) loads the task back.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-001",
      "acIndex": 2,
      "moduleId": "App"
    },
    {
      "target": "Edit task flow updates localStorage",
      "description": "Edit an existing task through the UI and assert that the updated task object is saved in localStorage and re‑loaded correctly after remount.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-002",
      "acIndex": 2,
      "moduleId": "App"
    },
    {
      "target": "Delete task flow removes entry from localStorage",
      "description": "Delete a task via UI, then check that localStorage no longer contains the task and that a subsequent reload does not render it.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-003",
      "acIndex": 1,
      "moduleId": "App"
    },
    {
      "target": "Toggle done status persists across reloads",
      "description": "Toggle a task's done flag, verify the change is saved to localStorage, and confirm after re‑mount the task appears with the correct visual state.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-004",
      "acIndex": 2,
      "moduleId": "App"
    },
    {
      "target": "App saves after any CRUD operation without errors",
      "description": "Perform create, edit, toggle, and delete actions sequentially and ensure StorageService.saveTasks is called each time without throwing.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-005",
      "acIndex": 1,
      "moduleId": "App"
    },
    {
      "target": "Responsive layout switches to vertical stack on narrow viewports",
      "description": "Render App with a viewport width ≤600px (using jsdom window resize) and assert that the form and list are stacked vertically.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-006",
      "acIndex": 0,
      "moduleId": "App"
    },
    {
      "target": "Responsive layout switches to two‑column on wide viewports",
      "description": "Render App with a viewport width ≥1024px and verify that the form and list are displayed side‑by‑side.",
      "framework": "Vitest + @testing-library/react",
      "storyId": "US-006",
      "acIndex": 1,
      "moduleId": "App"
    },
    {
      "target": "Application starts without runtime errors",
      "description": "Mount the root App component and assert that no console.error or uncaught exceptions are emitted.",
      "framework": "Vitest",
      "storyId": "US-008",
      "acIndex": 0,
      "moduleId": "App"
    }
  ],
  "e2e": [
    {
      "scenario": "Full CRUD user journey persists across reloads",
      "description": "Using Playwright, create a task, edit it, toggle its status, delete another task, then reload the page and verify all changes are reflected.",
      "criticalPath": true,
      "storyId": "US-008",
      "acIndex": 1,
      "moduleId": "Playwright"
    },
    {
      "scenario": "Create task persists after page reload",
      "description": "Create a new task via UI, reload the page, and assert the task still appears with status not done.",
      "criticalPath": true,
      "storyId": "US-001",
      "acIndex": 2,
      "moduleId": "Playwright"
    },
    {
      "scenario": "Edit task persists after page reload",
      "description": "Edit an existing task, reload, and verify the updated title/description are displayed.",
      "criticalPath": true,
      "storyId": "US-002",
      "acIndex": 2,
      "moduleId": "Playwright"
    },
    {
      "scenario": "Delete task does not reappear after reload",
      "description": "Delete a task, reload the page, and confirm the task is absent.",
      "criticalPath": true,
      "storyId": "US-003",
      "acIndex": 1,
      "moduleId": "Playwright"
    },
    {
      "scenario": "Responsive layout verification on mobile and desktop",
      "description": "Set viewport to 500px width, verify vertical stacking; then set to 1200px width and verify two‑column layout.",
      "criticalPath": true,
      "storyId": "US-006",
      "acIndex": -1,
      "moduleId": "Playwright"
    },
    {
      "scenario": "Accessibility audit of interactive elements",
      "description": "Run axe-core via Playwright on the loaded app and ensure no violations for ARIA roles, labels, and keyboard navigation.",
      "criticalPath": true,
      "storyId": "US-007",
      "acIndex": -1,
      "moduleId": "Playwright"
    },
    {
      "scenario": "LocalStorage quota exceeded error handling",
      "description": "Mock localStorage to throw quota exceeded on save, trigger a create action, and verify a user‑friendly error toast/message appears.",
      "criticalPath": false,
      "storyId": "US-005",
      "acIndex": 2,
      "moduleId": "Playwright"
    },
    {
      "scenario": "Application loads without runtime errors",
      "description": "Navigate to the app URL and assert that the console contains no error messages and the UI renders.",
      "criticalPath": true,
      "storyId": "US-008",
      "acIndex": 0,
      "moduleId": "Playwright"
    }
  ],
  "coverageTargets": {
    "unit": 85,
    "integration": 70,
    "e2e": 100
  }
}
