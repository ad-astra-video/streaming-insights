/**
 * Animated "live feed" canvas for the simulated Demo source. Colors are read
 * from the token layer (CSS custom properties), not hardcoded, so the sim
 * preview stays token-driven like every other surface.
 */
export function startSimCanvas(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  let raf = 0;
  const css = (n: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  const bg = css("--sim-bg");
  const fgA = css("--sim-a");
  const fgB = css("--sim-b");

  const render = (t: number) => {
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 6; i += 1) {
      const y = (t * 0.05 + (i * 0.2 * h) + h) % (h + 60) - 30;
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = i % 2 ? fgA : fgB;
      ctx.beginPath();
      ctx.arc((Math.sin(t * 0.003 + i) * 0.3 + 0.5) * w, y, 24 + i * 8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(render);
  };
  raf = requestAnimationFrame(render);

  return () => cancelAnimationFrame(raf);
}
