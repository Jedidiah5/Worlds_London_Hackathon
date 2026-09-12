// Approximate collision detection.
//
// A world model has no collision system and no notion of where the player is,
// so real physics is off the table. What we can measure is whether the picture
// is still changing: if the player holds forward and the frame stops moving,
// they have walked into something. That is what a wall feels like, and it is
// honest — we are reading the model's own output, not faking geometry.

const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 36;

export const STALL_THRESHOLD = 2.6; // mean abs luma delta, 0–255 scale
export const STALL_SAMPLES = 3; // consecutive stalled samples before "blocked"

export type FrameSampler = {
  /** Mean absolute luma change since the previous sample, or null if unavailable. */
  sample: () => number | null;
  reset: () => void;
};

export function createFrameSampler(): FrameSampler {
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let previous: Float32Array | null = null;

  const ensureCanvas = () => {
    if (canvas && context) return true;
    canvas = document.createElement("canvas");
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    context = canvas.getContext("2d", { willReadFrequently: true });
    return Boolean(context);
  };

  return {
    reset() {
      previous = null;
    },
    sample() {
      // The SDK puts our className on a wrapper, not the <video> itself, so
      // check both. Missing this makes stall detection silently never fire.
      const video = document.querySelector<HTMLVideoElement>(
        "video.world-video, .world-video video",
      );
      if (
        !video ||
        video.readyState < 2 ||
        !video.videoWidth ||
        !video.videoHeight ||
        !ensureCanvas() ||
        !context
      ) {
        return null;
      }

      context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
      const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
      const current = new Float32Array(SAMPLE_WIDTH * SAMPLE_HEIGHT);
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        current[p] =
          data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      }

      const last = previous;
      previous = current;
      if (!last) return null;

      let total = 0;
      for (let i = 0; i < current.length; i += 1) {
        total += Math.abs(current[i] - last[i]);
      }
      return total / current.length;
    },
  };
}
