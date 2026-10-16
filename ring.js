// The kitchen ring for a new order: about five seconds of a three-note phone-style ring
// and a matching buzz, like a delivery partner app. Plain data, so it can be tested.

export const RING_SECONDS = 5;

// Each second: three short notes, then a pause. Times and lengths are in seconds.
export function ringTones(seconds = RING_SECONDS) {
  const tones = [];
  for (let s = 0; s < seconds; s++) {
    tones.push({ at: s, freq: 988, length: 0.16 });
    tones.push({ at: s + 0.2, freq: 784, length: 0.16 });
    tones.push({ at: s + 0.4, freq: 988, length: 0.16 });
  }
  return tones;
}

// navigator.vibrate takes buzz, pause, buzz, ... in milliseconds.
export function ringVibration(seconds = RING_SECONDS) {
  const pattern = [];
  for (let s = 0; s < seconds; s++) pattern.push(600, 400);
  pattern.pop(); // no pause after the last buzz
  return pattern;
}
