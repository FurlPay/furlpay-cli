const test = require("node:test");
const assert = require("node:assert");
const { HawkesVolatilityEstimator } = require("../dist/services/hawkes");

test("Hawkes Point Process: Initial baseline intensity", () => {
  const hawkes = new HawkesVolatilityEstimator({ mu: 0.20, alpha: 0.50, beta: 0.80 });
  const metrics = hawkes.getMetrics();

  assert.strictEqual(metrics.baseline, 0.20);
  assert.strictEqual(metrics.branchingRatio, 0.625);
  assert.strictEqual(metrics.isCascadeRisk, false);
  assert.strictEqual(metrics.eventCount, 0);
  assert(Math.abs(metrics.intensity - 0.20) < 0.001, "Intensity without events should equal baseline mu");
});

test("Hawkes Point Process: Intensity jumps on incoming trade execution", () => {
  const hawkes = new HawkesVolatilityEstimator({ mu: 0.20, alpha: 0.50, beta: 0.80 });
  const now = Date.now();

  // Record an event at current time
  hawkes.recordEvent(now);
  const intensityAfter1 = hawkes.getIntensity(now);

  // Intensity should jump by alpha (0.50) to 0.70
  assert(Math.abs(intensityAfter1 - 0.70) < 0.01, `Intensity should be ~0.70, got ${intensityAfter1}`);

  // Record another event immediately
  hawkes.recordEvent(now);
  const intensityAfter2 = hawkes.getIntensity(now);

  // Intensity should jump by another alpha to ~1.20
  assert(Math.abs(intensityAfter2 - 1.20) < 0.01, `Intensity should be ~1.20, got ${intensityAfter2}`);
});

test("Hawkes Point Process: Exponential decay over elapsed time", () => {
  const hawkes = new HawkesVolatilityEstimator({ mu: 0.20, alpha: 0.50, beta: 0.80 });
  const now = Date.now();

  hawkes.recordEvent(now);
  const jumpIntensity = hawkes.getIntensity(now);

  // Evaluate intensity 1 second later (1000ms)
  const decayedIntensity1s = hawkes.getIntensity(now + 1000);
  assert(decayedIntensity1s < jumpIntensity, "Intensity must decay over elapsed time");

  // Evaluate intensity 5 seconds later
  const decayedIntensity5s = hawkes.getIntensity(now + 5000);
  assert(decayedIntensity5s < decayedIntensity1s, "Intensity must continue decaying");
  assert(decayedIntensity5s >= 0.20, "Intensity cannot decay below baseline mu");
});

test("Hawkes Point Process: Self-exciting cascade risk detection", () => {
  const hawkes = new HawkesVolatilityEstimator({ mu: 0.20, alpha: 0.50, beta: 0.80 });
  const now = Date.now();

  assert.strictEqual(hawkes.isCascadeRisk(now), false, "Should not detect cascade initially");

  // Rapidly record 6 trade executions in a tight 200ms window (high frequency cluster)
  for (let i = 0; i < 6; i++) {
    hawkes.recordEvent(now + i * 30);
  }

  const cascadeDetected = hawkes.isCascadeRisk(now + 200);
  assert.strictEqual(cascadeDetected, true, "Clustered trade arrivals must trigger cascade risk warning");
});
