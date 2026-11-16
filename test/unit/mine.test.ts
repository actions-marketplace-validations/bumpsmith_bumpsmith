import { describe, expect, it } from "vitest";
import { parseTitle } from "../../src/bench/mine.ts";

describe("dependabot title parsing", () => {
  it.each([
    ["Bump nanoid from 4.0.2 to 5.0.9", { pkg: "nanoid", from: "4.0.2", to: "5.0.9", dir: null }],
    [
      "build(deps-dev): bump @types/node from 20.1.0 to 22.0.0",
      { pkg: "@types/node", from: "20.1.0", to: "22.0.0", dir: null },
    ],
    [
      "chore(deps): Bump zod from 3.23.8 to 4.0.1 in /web",
      { pkg: "zod", from: "3.23.8", to: "4.0.1", dir: "/web" },
    ],
  ])("%s", (title, want) => expect(parseTitle(title)).toEqual(want));
  it("ignores grouped updates", () => {
    expect(
      parseTitle("Bump the npm_and_yarn group across 2 directories with 3 updates"),
    ).toBeNull();
  });
});
