import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Drift guard for the wordmark CLS fix. Every <img src="/librito.svg"> must
// carry width/height attributes matching the SVG's intrinsic aspect ratio so
// the browser reserves the logo's box before the file loads. Without them the
// image is 0px until it decodes and the surrounding content jumps (the tagline
// paints up where the logotype belongs on the landing page; the header logo
// pops in from the left). The attributes only supply the RATIO — CSS drives the
// real size — so resizing/repositioning the logo can't break the fix. The one
// thing that can: swapping librito.svg for a different-aspect asset without
// updating the attributes. This test fails loudly if that happens.

const root = resolve(__dirname, "../..");

function svgViewBoxRatio(): number {
  const svg = readFileSync(resolve(root, "static/librito.svg"), "utf8");
  const m = svg.match(/viewBox="([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
  if (!m) throw new Error("static/librito.svg has no parseable viewBox");
  const [, , , w, h] = m;
  return Number(w) / Number(h);
}

// Pull every <img ...> tag (attributes may span multiple lines) that points at
// the wordmark SVG out of a component's source.
function wordmarkImgs(relPath: string): string[] {
  const src = readFileSync(resolve(root, relPath), "utf8");
  const tags = src.match(/<img\b[\s\S]*?\/?>/g) ?? [];
  return tags.filter((t) => /src="\/librito\.svg"/.test(t));
}

function attr(tag: string, name: string): number | null {
  const m = tag.match(new RegExp(`\\b${name}="([\\d.]+)"`));
  return m ? Number(m[1]) : null;
}

const CONSUMERS = [
  "src/routes/+page.svelte",
  "src/lib/components/Header.svelte",
];

describe("wordmark <img> dimensions (CLS drift guard)", () => {
  const ratio = svgViewBoxRatio();

  for (const relPath of CONSUMERS) {
    describe(relPath, () => {
      const imgs = wordmarkImgs(relPath);

      it("references the wordmark SVG at least once", () => {
        expect(imgs.length).toBeGreaterThan(0);
      });

      it.each(imgs.map((t, i) => [i, t] as const))(
        "img #%# declares width+height matching the SVG aspect ratio",
        (_i, tag) => {
          const w = attr(tag, "width");
          const h = attr(tag, "height");
          expect(w, `missing width on: ${tag}`).not.toBeNull();
          expect(h, `missing height on: ${tag}`).not.toBeNull();
          // Ratio, not absolute size — CSS is free to resize the logo.
          expect(w! / h!).toBeCloseTo(ratio, 2);
        },
      );
    });
  }
});
