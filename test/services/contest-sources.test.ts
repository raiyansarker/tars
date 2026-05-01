import { describe, expect, test } from "bun:test"

import {
  normalizeCodeforcesContests,
  parseAtCoderContestsFromHtml
} from "../../src/services/contest-sources"

describe("contest source normalization", () => {
  test("normalizes future Codeforces contests and drops finished ones", () => {
    const contests = normalizeCodeforcesContests([
      {
        id: 101,
        name: "Codeforces Round 101",
        type: "CF",
        phase: "BEFORE",
        durationSeconds: 7200,
        startTimeSeconds: 1774929600
      },
      {
        id: 100,
        name: "Finished Contest",
        type: "ICPC",
        phase: "FINISHED",
        durationSeconds: 7200,
        startTimeSeconds: 1774843200
      }
    ])

    expect(contests).toHaveLength(1)
    expect(contests[0]).toMatchObject({
      id: "codeforces-101",
      platform: "Codeforces",
      title: "Codeforces Round 101",
      durationMinutes: 120
    })
  })

  test("parses upcoming and daily AtCoder contests from the official page structure", () => {
    const html = `
      <html>
        <body>
          <h3>Upcoming Contests</h3>
          <div>
            <table>
              <tbody>
                <tr>
                  <td><a href="https://www.timeanddate.com">2026-05-02 21:00:00+0900</a></td>
                  <td><a href="/contests/abc456">AtCoder Beginner Contest 456</a></td>
                  <td>01:40</td>
                  <td>- 1999</td>
                </tr>
              </tbody>
            </table>
          </div>
          <h3>Daily Contests</h3>
          <table>
            <tbody>
              <tr>
                <td><a href="https://www.timeanddate.com">2026-05-01 20:00:00+0900</a></td>
                <td><a href="/contests/aw0060">AtCoder Weekday Contest 0060 Beta</a></td>
                <td>01:00</td>
                <td>-</td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    `

    const contests = parseAtCoderContestsFromHtml(html)

    expect(contests).toHaveLength(2)
    expect(contests[0]).toMatchObject({
      id: "atcoder-aw0060",
      platform: "AtCoder",
      title: "AtCoder Weekday Contest 0060 Beta",
      durationMinutes: 60
    })
    expect(contests[1]).toMatchObject({
      id: "atcoder-abc456",
      platform: "AtCoder",
      title: "AtCoder Beginner Contest 456",
      ratedRange: "- 1999",
      durationMinutes: 100
    })
  })
})
