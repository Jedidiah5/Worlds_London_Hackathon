// Generates the anchor frame the world model is conditioned on.
//
//   RUNWARE_API_KEY=... node scripts/make-anchor.mjs
//
// The anchor decides what the house *is* — LingBot World 2 takes its visual
// identity from this single image, so it is worth regenerating until one looks
// right. Any 16:9 photo of a bedroom works just as well; this is only a
// convenience because the hackathon ships Runware credits.

import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public/anchors/bedroom.png",
);

// First-person, standing, doorway visible — the model needs somewhere to walk.
const PROMPT = [
  "First-person photograph taken from standing eye height in a small 1970s English terraced house bedroom,",
  "looking across a brass-framed double bed with a rumpled quilt toward an open bedroom doorway leading to a dim landing,",
  "dense faded floral wallpaper, a heavy dark wood wardrobe against the left wall, thin curtains with pale grey morning light behind them,",
  "worn carpet, no people, no hands, no mirrors, nobody visible,",
  "photographic, natural available light, slightly desaturated, fine 35mm film grain, deep focus, wide angle",
].join(" ");

const NEGATIVE = [
  "person, people, figure, face, hands, body, reflection in mirror, animal,",
  "text, watermark, logo, cartoon, illustration, render, cgi, distorted geometry, fisheye",
].join(" ");

const apiKey = process.env.RUNWARE_API_KEY;
if (!apiKey) {
  console.error(
    "RUNWARE_API_KEY is not set.\n" +
      "Either export it and re-run, or just drop any 16:9 bedroom photo at\n" +
      "  public/anchors/bedroom.png\n" +
      "(the title screen also has a file picker for a one-off anchor).",
  );
  process.exit(1);
}

const response = await fetch("https://api.runware.ai/v1", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify([
    {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model: "runware:101@1",
      positivePrompt: PROMPT,
      negativePrompt: NEGATIVE,
      // LingBot World 2 renders 1664x960; matching the anchor avoids a crop.
      width: 1664,
      height: 960,
      steps: 30,
      numberResults: 1,
      outputType: "URL",
      outputFormat: "PNG",
    },
  ]),
});

const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`Runware returned ${response.status}:`, JSON.stringify(payload, null, 2));
  process.exit(1);
}

const imageUrl = payload?.data?.[0]?.imageURL;
if (!imageUrl) {
  console.error("No image URL in the response:", JSON.stringify(payload, null, 2));
  process.exit(1);
}

const image = await fetch(imageUrl);
if (!image.ok) {
  console.error(`Could not download the generated image (${image.status}).`);
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, Buffer.from(await image.arrayBuffer()));
console.log(`Anchor written to ${OUT}`);
console.log(`Source: ${imageUrl}`);
