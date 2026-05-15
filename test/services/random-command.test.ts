import { describe, expect, test } from "bun:test";
import { resolveRandomRatingRange } from "../../src/services/discord-bot";

describe("resolveRandomRatingRange", () => {
  test("medium (default): [rating, rating+200]", () => {
    expect(resolveRandomRatingRange(1500, "medium")).toEqual([1500, 1700]);
  });

  test("easy: [rating-100, rating+100]", () => {
    expect(resolveRandomRatingRange(1500, "easy")).toEqual([1400, 1600]);
  });

  test("hard: [rating+400, rating+600]", () => {
    expect(resolveRandomRatingRange(1500, "hard")).toEqual([1900, 2100]);
  });

  test("unknown difficulty falls back to medium", () => {
    expect(resolveRandomRatingRange(1500, "unknown")).toEqual([1500, 1700]);
  });

  test("explicit low rating (e.g. 800)", () => {
    expect(resolveRandomRatingRange(800, "medium")).toEqual([800, 1000]);
  });

  test("explicit specific rating (e.g. 1100)", () => {
    expect(resolveRandomRatingRange(1100, "medium")).toEqual([1100, 1300]);
    expect(resolveRandomRatingRange(1100, "easy")).toEqual([1000, 1200]);
    expect(resolveRandomRatingRange(1100, "hard")).toEqual([1500, 1700]);
  });
});
