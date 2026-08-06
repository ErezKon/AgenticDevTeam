# Pac-Man — Plain-Language App Description

## What Is It?

A browser-based clone of the classic Pac-Man arcade game. One player controls a yellow, round character through a maze, eating dots and avoiding ghosts. It should be playable on both desktop and mobile.

---

## The Maze

The game takes place on a flat, 2D maze made of walls and corridors. The maze is filled with small dots and has four larger, flashing dots — one near each corner. These larger dots are called power pellets.

There is at least one tunnel on the maze — an opening on the left side that connects to an opening on the right side. Anything that goes into one side comes out the other.

In the center of the maze there is a small enclosed box (the "ghost house") where the ghosts start.

---

## Pac-Man (The Player)

- The player moves Pac-Man using **arrow keys or WASD** on a keyboard. On phones or tablets, the player can **swipe** or use **on-screen directional buttons**.
- Pac-Man moves continuously in whatever direction the player last chose. He only stops when he hits a wall.
- Pac-Man's mouth opens and closes as he moves (the classic chomping animation), and he faces whichever direction he's traveling.
- When Pac-Man moves over a dot, he eats it and it disappears.
- When Pac-Man moves over a power pellet, he eats it and something special happens to the ghosts (see below).

---

## The Ghosts

There are **four ghosts**, each a different color and each with a name (for example: Blinky the red one, Pinky the pink one, Inky the cyan one, and Clyde the orange one).

### How They Move

Each ghost has its own personality when chasing Pac-Man:

- **One** heads straight for wherever Pac-Man currently is.
- **One** tries to get ahead of Pac-Man — aiming for a spot a few tiles in front of him.
- **One** uses a flanking approach — it tries to cut Pac-Man off from the side.
- **One** is a bit of a wildcard — it sometimes chases, sometimes wanders randomly.

The ghosts don't chase all the time. They alternate between **chasing** Pac-Man and **scattering** to their own corner of the maze. This switching happens on a timer.

### When Pac-Man Eats a Power Pellet

All four ghosts become **scared**. They:
- Turn a dark blue (or other uniform "vulnerable" color)
- Reverse direction immediately
- Slow down
- Can now be **eaten** by Pac-Man

This scared state lasts for a limited time. During the **last two seconds**, the ghosts flash/blink to warn the player it's about to wear off.

If Pac-Man catches a scared ghost, the ghost turns into just a pair of **floating eyes** that travel back to the ghost house in the center. Once there, the ghost regenerates and comes back out as normal.

Eating ghosts in a row during a single power pellet gives escalating points: **200 → 400 → 800 → 1,600**.

### Ghost House

At the start of each level (and after losing a life), ghosts begin inside the ghost house and leave one at a time, with short delays between each.

---

## Bonus Fruit

Twice per level, a **bonus item** (like a cherry, strawberry, or orange) appears near the center of the maze. The first one shows up after Pac-Man has eaten about 70 dots, and the second after about 170 dots.

The type of fruit and how many points it's worth changes depending on the level:
- Level 1: Cherry (100 points)
- Level 2: Strawberry (300 points)
- Level 3: Orange (500 points)
- …and so on for higher levels

If the player doesn't grab the fruit in time, it disappears on its own.

---

## Lives and Game Over

- The player starts with **3 lives**.
- When a ghost (that isn't scared) touches Pac-Man, Pac-Man **dies** and loses a life. There's a brief death animation, then the level resets with the remaining dots still in place.
- Reaching **10,000 points** earns an **extra life**.
- When all lives are gone, the game is **over**. A Game Over screen appears showing the final score and an option to play again.

---

## Levels and Difficulty

- A level is **complete** when every dot and power pellet has been eaten.
- The next level uses the same maze layout but is **harder**:
  - Ghosts move faster
  - The scared/vulnerable time after eating a power pellet gets shorter
  - The ghosts spend less time scattering and more time chasing
- There should be at least **20 levels** of increasing difficulty. After that, the hardest settings just repeat.

---

## Scoring

| What | Points |
|---|---|
| Regular dot | 10 |
| Power pellet | 50 |
| 1st ghost eaten (per pellet) | 200 |
| 2nd ghost eaten | 400 |
| 3rd ghost eaten | 800 |
| 4th ghost eaten | 1,600 |
| Bonus fruit | Depends on level |

The **current score** and the **all-time high score** should always be visible on screen during gameplay.

---

## High Scores

- The game keeps a **top-10 high score list**.
- If the player's score makes the list after a Game Over, they can enter their **initials** (3 letters).
- High scores should be **saved between sessions** — closing the browser and coming back later should still show them.

---

## Screens and Flow

1. **Start Screen** — Shows the game title, the high score, and a way to start playing.
2. **Countdown** — When starting, a brief "3… 2… 1… GO!" countdown before gameplay begins.
3. **Gameplay** — The main game with the maze, Pac-Man, ghosts, score, and lives displayed.
4. **Pause** — The player can pause and unpause the game. While paused, everything freezes and a "Paused" message is shown.
5. **Level Complete** — Brief transition when all dots are cleared before the next level starts.
6. **Game Over** — Final score displayed, option to enter initials if it's a high score, and option to restart.

---

## Audio

The game should have sound effects and background audio:

- **Start-up jingle** — plays at the beginning of each level or after losing a life, before gameplay resumes.
- **Dot-eating sound** — a short "waka-waka" when Pac-Man eats dots.
- **Power pellet sound** — a distinct sound when eating one of the big pellets.
- **Ghost-eating sound** — plays when Pac-Man eats a scared ghost.
- **Death sound** — a descending tone when Pac-Man is caught.
- **Bonus fruit collected** — a quick reward sound.
- **Extra life** — a special chime when the player earns a bonus life at 10,000 points.
- **Background siren** — a continuous looping sound during normal gameplay. It should change speed/pitch as the level progresses (e.g., gets faster as fewer dots remain).
- **Mute button** — the player should be able to turn all sound on or off.

---

## Device and Performance Expectations

- Should work in **all modern browsers** (Chrome, Firefox, Safari, Edge).
- Should run **smoothly at 60 frames per second** with no noticeable lag when pressing keys or swiping.
- Should look and play well on screens ranging from **phone-sized (375px wide) to large desktop monitors (2560px wide)**.
- The whole game (all images, sounds, code) should be **small enough to load quickly** — under 2 MB total.
- After loading once, the game should **work offline** (no internet needed to keep playing).

---

## Accessibility

- The game must be **fully playable with just a keyboard** (no mouse required for menus either).
- Menu buttons and options should have **visible focus indicators** so keyboard users can tell what's selected.
- There should be a **colorblind-friendly option** that changes the ghost colors to a palette that's easier to distinguish for people with color vision differences.

---
