import { describe, expect, test } from "bun:test";

function resolveRatingRange(
  explicitRating: string | undefined,
  profileRating: number,
): [number, number] {
  const rating = explicitRating ? Number(explicitRating) : profileRating;
  return [rating, explicitRating ? rating : 3500];
}

describe("/random rating range resolution", () => {
  test("no explicit rating: [profileRating, 3500]", () => {
    expect(resolveRatingRange(undefined, 1500)).toEqual([1500, 3500]);
  });

  test("explicit rating: exact [rating, rating]", () => {
    expect(resolveRatingRange("1100", 1500)).toEqual([1100, 1100]);
  });

  test("fallback profile rating 800: [800, 3500]", () => {
    expect(resolveRatingRange(undefined, 800)).toEqual([800, 3500]);
  });

  test("explicit overrides profile rating", () => {
    expect(resolveRatingRange("2000", 800)).toEqual([2000, 2000]);
  });
});
