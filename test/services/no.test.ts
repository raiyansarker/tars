import { expect, test, describe } from "bun:test"
import { generateShameExcuse } from "../../src/services/no"

describe("shame excuse generator", () => {
  test("returns a random excuse from the list", () => {
    const excuse = generateShameExcuse()
    expect(typeof excuse).toBe("string")
    expect(excuse.length).toBeGreaterThan(0)
  })

  test("returns different excuses on multiple calls", () => {
    const excuses = new Set()
    for (let i = 0; i < 100; i++) {
      excuses.add(generateShameExcuse())
    }
    // With ~70 excuses, we should get more than 10 unique ones in 100 calls
    expect(excuses.size).toBeGreaterThan(10)
  })
})
