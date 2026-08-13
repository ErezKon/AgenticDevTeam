# Team Retrospective Board Web App

## Summary

Build a lightweight web application that helps software teams run recurring sprint retrospectives. The app should allow a facilitator to create a retro session, teammates to add cards under columns like "Went Well", "To Improve", and "Actions", and then collaborate in real time to group, vote, and track action items.

## Goals

- Make it very fast to spin up a new retro, invite the team, and capture feedback.
- Keep the UI simple enough that non-technical users can use it without training.
- Support fully remote teams working from different locations.

## Core Features

### 1. Session Management
- A facilitator can create a new retro session with:
  - A title (e.g. "Sprint 24 Retro")
  - An optional description
  - A date/time (default to now)
- The system generates a shareable link (URL) for the session.
- No login is required for basic usage, but sessions should have a random, hard-to-guess ID.

### 2. Columns & Cards
- Default columns: "Went Well", "To Improve", "Questions", "Actions".
- The facilitator can rename, add, or remove columns.
- Any participant can add cards to any column with:
  - Short text (1–3 sentences)
  - Optional author name or initials
- Cards can be edited or deleted by the person who created them (or by the facilitator).

### 3. Grouping & Voting
- Participants can drag and drop cards to reorder them or move them between columns.
- Cards can be grouped into clusters (e.g. "Deployment issues").
  - A cluster has a title and contains one or more cards.
- Each participant has a limited number of votes per session (configurable, default 5).
- Voting rules:
  - A participant can assign multiple votes to the same card/cluster or spread votes across several.
  - The UI shows the current vote count per card/cluster.

### 4. Action Items
- From any card or cluster, the facilitator can create an "Action Item" with:
  - Title
  - Description
  - Owner (free-text or simple dropdown of known participants)
  - Due date (optional)
- Action items appear in a separate, always-visible list.
- Action items can be marked as done and edited later.

### 5. Real-Time Collaboration
- Changes to cards, votes, and action items should appear in near real time for all connected participants.
- If real-time sync is temporarily unavailable, the app should still work for a single user and sync changes when connection is restored.

## Non-Goals (Nice to Have Later)

These are explicitly **not required** for the first version but should be kept in mind when designing the system:

- Authentication and user accounts.
- Persistent team workspaces and history of all retros per team.
- Exporting data to Jira, Trello, or other tools.

## Technical Constraints

- Build as a single-page web application.
- Should run in all modern browsers.
- Back-end and database choice is flexible; a simple implementation using a hosted database or file-based store is acceptable for now.
