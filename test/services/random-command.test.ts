import { describe, expect, test } from "bun:test";

// Pure logic: rating used directly as exact filter
function resolveRating(explicitRating: string | undefined, profileRating: number): number {
  return explicitRating ? Number(explicitRating) : profileRating;
}

describe("/random rating resolution", () => {
  test("uses explicit rating when provided", () => {
    expect(resolveRating("1100", 1500)).toBe(1100);
  });

  test("falls back to profile rating when no explicit rating", () => {
    expect(resolveRating(undefined, 1500)).toBe(1500);
  });

  test("falls back to 800 when profile rating is 800 (default)", () => {
    expect(resolveRating(undefined, 800)).toBe(800);
  });

  test("explicit rating overrides profile rating", () => {
    expect(resolveRating("2000", 800)).toBe(2000);
  });
});
