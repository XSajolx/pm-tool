import type { Branding } from "./api.js";

/**
 * Row 108: the accent colour drives every "indigo" utility through CSS
 * variables (see tailwind.config.js + index.css), so one setting recolours
 * buttons, links, active nav and focus rings. The favicon and tab title follow
 * the workspace name.
 */
const SHADES: [number, number][] = [
  [50, 96], [100, 92], [200, 84], [300, 74], [400, 64], [500, 56], [600, -1], [700, -9], [800, -17], [900, -25],
];

function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function applyAccent(hex: string) {
  const hsl = hexToHsl(hex);
  const root = document.documentElement;
  if (!hsl) return;
  const [h, s, l] = hsl;
  for (const [shade, target] of SHADES) {
    const lightness = target > 0 ? target : Math.max(8, Math.min(95, l + target));
    // The chosen colour is the 600 shade; lighter tints keep the hue but drop saturation a little so 50/100 stay soft.
    const sat = target > 0 ? Math.min(100, s * (target >= 84 ? 1 : 1.05)) : s;
    const [r, g, b] = hslToRgb(h, sat, lightness);
    root.style.setProperty(`--brand-${shade}`, `${r} ${g} ${b}`);
  }
  root.style.setProperty("--brand-hex", hex);
}

function initialsIcon(name: string, hex: string) {
  const text = (name.trim().slice(0, 2) || "PM").toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${hex}'/><text x='16' y='21' text-anchor='middle' font-family='system-ui,sans-serif' font-size='14' font-weight='700' fill='white'>${text}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function applyBranding(b: Branding | null | undefined) {
  if (!b) return;
  applyAccent(b.brandColor);
  const link = (document.querySelector('link[rel="icon"]') as HTMLLinkElement | null) ?? Object.assign(document.createElement("link"), { rel: "icon" });
  if (!link.parentNode) document.head.appendChild(link);
  link.href = b.brandFaviconUrl || initialsIcon(b.name, b.brandColor);
  document.title = b.name ? `${b.name} · PM` : "PM Tool";
}
