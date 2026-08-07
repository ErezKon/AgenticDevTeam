import React, { useEffect, useRef } from 'react';
import gameEngine from '../engine/engineInstance';
import { GameState } from '../engine/types';

/**
 * Renderer component mounts a canvas and draws the current game state on each tick.
 * It subscribes to the GameEngine for state updates.
 */
const Renderer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Draw the entire game state onto the canvas
  const draw = (ctx: CanvasRenderingContext2D, state: GameState) => {
    const { pacMan, ghosts, dots, fruits, walls } = state;
    const { width, height } = ctx.canvas;
    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw walls (gray squares)
    ctx.fillStyle = '#555';
    walls.forEach(w => {
      ctx.fillRect(w.position.x, w.position.y, w.size, w.size);
    });

    // Draw dots (small white circles)
    ctx.fillStyle = '#fff';
    dots.forEach(d => {
      ctx.beginPath();
      ctx.arc(d.position.x + d.size / 2, d.position.y + d.size / 2, d.size / 6, 0, Math.PI * 2);
      ctx.fill();
    });

    // Draw fruits (red circles)
    ctx.fillStyle = '#f00';
    fruits.forEach(f => {
      ctx.beginPath();
      ctx.arc(f.position.x + f.size / 2, f.position.y + f.size / 2, f.size / 2, 0, Math.PI * 2);
      ctx.fill();
    });

    // Draw ghosts (blue squares)
    ctx.fillStyle = '#00f';
    ghosts.forEach(g => {
      ctx.fillRect(g.position.x, g.position.y, g.size, g.size);
    });

    // Draw Pac‑Man (yellow circle with mouth)
    ctx.fillStyle = '#ff0';
    const { x, y } = pacMan.position;
    const radius = pacMan.size / 2;
    const startAngle = pacMan.mouthOpen ? 0.25 * Math.PI : 0;
    const endAngle = pacMan.mouthOpen ? 1.75 * Math.PI : 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(x + radius, y + radius);
    ctx.arc(x + radius, y + radius, radius, startAngle, endAngle, false);
    ctx.closePath();
    ctx.fill();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Initial draw
    draw(ctx, gameEngine.getState());

    // Subscribe to engine updates
    const unsubscribe = gameEngine.subscribe(state => {
      draw(ctx, state);
    });

    // Start the game loop – 60fps using requestAnimationFrame
    let animationFrameId: number;
    const loop = () => {
      gameEngine.tick();
      animationFrameId = requestAnimationFrame(loop);
    };
    animationFrameId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animationFrameId);
      unsubscribe();
    };
  }, []);

  // Canvas size – simple fixed size for now (e.g., 400x400)
  return <canvas ref={canvasRef} width={400} height={400} data-testid="game-canvas" />;
};

export default Renderer;
