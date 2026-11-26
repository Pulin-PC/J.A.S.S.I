// Hands-free flow: "Jassi" → request → answer → 5 s follow-up → sleep. A pretend microphone stands in for the device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEar, WAKE } from "../public/ear.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
function fakeMic() {
  const m = { on: false, starts: 0, stops: 0, say: null, end: null };
  m.engine = {
    start(onText, onEnd) { m.on = true; m.starts++; m.say = onText; m.end = onEnd; },
    stop() { m.on = false; m.stops++; },
  };
  return m;
}
function makeEar(mic, followMs = 150) {
  const log = { wakes: 0, sleeps: 0, texts: [] };
  const ear = createEar({ engine: mic.engine, followMs,
    onWake: () => log.wakes++, onSleep: () => log.sleeps++, onText: (t, final) => log.texts.push([t, final]) });
  return { ear, log };
}

test("the wake word: Jassi and the ways speech engines hear it", () => {
  for (const s of ["Jassi open youtube", "hey jassi, what's the time", "jessie set a timer", "ok Jassy"]) assert.ok(WAKE.test(s), s);
  for (const s of ["open youtube", "jasmine tea", "the classic one"]) assert.ok(!WAKE.test(s), s);
});

test("words before 'Jassi' are ignored; the request after it is heard and closed by silence", async () => {
  const mic = fakeMic(), { ear, log } = makeEar(mic);
  ear.start();
  assert.equal(ear.mode, "wake");
  mic.say("so anyway open youtube", false);
  assert.deepEqual(log.texts, []);                         // no wake word: nothing happens
  mic.say("so anyway open youtube jassi open", false);
  assert.equal(log.wakes, 1);
  mic.say("so anyway open youtube jassi open instagram", false);
  assert.equal(ear.mode, "req");
  await sleep(1000);
  assert.deepEqual(log.texts.at(-1), ["open instagram", true]);
  assert.equal(ear.mode, "paused");                        // not listening while J.A.S.S.I answers
  assert.equal(mic.on, false);
});

test("after an answer: 5 s to follow up without the wake word, then back to sleep", async () => {
  const mic = fakeMic(), { ear, log } = makeEar(mic, 200);
  ear.start();
  ear.follow();
  assert.equal(ear.mode, "follow"); assert.equal(mic.on, true);
  mic.say("and set a timer for 5 minutes", true);
  await sleep(400);
  assert.deepEqual(log.texts.at(-1), ["and set a timer for 5 minutes", true]);
  ear.follow();
  await sleep(300);                                        // nothing said
  assert.equal(ear.mode, "wake"); assert.equal(log.sleeps, 1);
  const before = log.texts.length;
  mic.say("open youtube", false);                          // now it needs "Jassi" again
  assert.equal(log.texts.length, before);
});

test("'Jassi' on its own waits for the request; the device closing its session just reopens it", async () => {
  const mic = fakeMic(), { ear, log } = makeEar(mic, 800);
  ear.start();
  mic.say("jassi", false);
  assert.equal(ear.mode, "follow"); assert.equal(log.wakes, 1);
  mic.end();                                               // the speech engine timed out
  await sleep(200);
  assert.equal(mic.on, true); assert.equal(mic.starts, 2);
  mic.say("open maps", true);
  await sleep(400);
  assert.deepEqual(log.texts.at(-1), ["open maps", true]);
});

test("the mic button skips the wake word; off means off", () => {
  const mic = fakeMic(), { ear, log } = makeEar(mic);
  ear.start();
  ear.now();
  assert.equal(ear.mode, "follow"); assert.equal(log.wakes, 1);
  ear.stop();
  assert.equal(ear.mode, "off"); assert.equal(mic.on, false);
  assert.equal(ear.now(), false);
});
