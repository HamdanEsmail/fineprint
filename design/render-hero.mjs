// Renders the README hero (docs/hero.png, 1600x800) and the link-preview image (public/assets/social.png,
// 1200x630) from design/hero.html, with headless Chrome and sharp. No new dependency, no network beyond one
// plain GET of the live home.
//
//   node design/render-hero.mjs            reuse design/shot/home.png if it is there, else take it
//   node design/render-hero.mjs --capture  take a fresh screenshot of the live home first
//
// The live home is captured at 1280 wide (2x, so the crop stays sharp), then cropped to the inside of the
// featured catch card: the comp draws its own card border and shadow around it. The crop box is in device
// pixels of that 2560x2000 capture; if the home's layout or the featured catch changes, re-measure it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HOME_URL = "https://fineprint.hamdanesmail12-7a9.workers.dev/";
const SHOT_DIR = resolve(ROOT, "design/shot");
const HOME_PNG = resolve(SHOT_DIR, "home.png");
const CATCH_PNG = resolve(SHOT_DIR, "catch.png");
const COMP = pathToFileURL(resolve(ROOT, "design/hero.html")).href;

// Inside the featured catch's 1.5px border. The bottom edge ends a complete row in both columns, one row
// under the highlighted change, just above the next row's first pixel; the comp then gives the card its own
// paper under it, so the excerpt reads as framed rather than clipped.
const CATCH_BOX = { left: 1227, top: 266, width: 1134, height: 903 };

const OUTPUTS = [
  { file: "docs/hero.png", window: "800,400", scale: 2, width: 1600, height: 800, maxBytes: 400 * 1024 },
  { file: "public/assets/social.png", window: "1200,630", scale: 1, width: 1200, height: 630, maxBytes: 300 * 1024 },
];

function chrome(args) {
  const base = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb", "--virtual-time-budget=6000"];
  const run = spawnSync(CHROME, [...base, ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`chrome exited ${run.status}: ${run.stderr}`);
}

mkdirSync(SHOT_DIR, { recursive: true });

if (process.argv.includes("--capture") || !existsSync(HOME_PNG)) {
  chrome(["--force-device-scale-factor=2", "--window-size=1280,1000", `--screenshot=${HOME_PNG}`, HOME_URL]);
  console.log("captured", HOME_PNG);
}

const home = await sharp(HOME_PNG).metadata();
if (home.width !== 2560 || home.height !== 2000) throw new Error(`home.png is ${home.width}x${home.height}, expected 2560x2000`);
await sharp(HOME_PNG).extract(CATCH_BOX).png().toFile(CATCH_PNG);

for (const out of OUTPUTS) {
  const raw = resolve(SHOT_DIR, `raw-${out.width}.png`);
  chrome([`--force-device-scale-factor=${out.scale}`, `--window-size=${out.window}`, `--screenshot=${raw}`, COMP]);
  const target = resolve(ROOT, out.file);
  await sharp(raw).png({ compressionLevel: 9, effort: 10, palette: true, quality: 100, colours: 256, dither: 0.6 }).toFile(target);
  const meta = await sharp(target).metadata();
  const bytes = statSync(target).size;
  if (meta.width !== out.width || meta.height !== out.height) throw new Error(`${out.file} is ${meta.width}x${meta.height}, expected ${out.width}x${out.height}`);
  if (bytes > out.maxBytes) throw new Error(`${out.file} is ${bytes} bytes, over ${out.maxBytes}`);
  console.log(`${out.file}  ${meta.width}x${meta.height}  ${bytes} bytes`);
}
