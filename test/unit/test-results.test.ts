import { describe, expect, it } from "vitest";
import type { CheckResult } from "../../src/schemas/job.ts";
import { compareWithBaseline, parseTestResults } from "../../src/verify/verify.ts";

const PYTEST = `...................F
=========================== short test summary info ============================
FAILED tests/components/opinet/test_geo.py::test_coordinate_conversion_loop - ModuleNotFoundError: No module named 'pyproj'
ERROR tests/test_db.py::test_conn - OperationalError
1 failed, 19 passed, 1 error in 1.75s`;

const VITEST = ` ❯ src/a.test.ts (3 tests | 1 failed) 12ms
   × adds numbers 5ms
 FAIL  src/a.test.ts > math > adds numbers
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)`;

const JEST = `FAIL src/b.test.js
  ● Suite › does a thing

Tests:       1 failed, 7 passed, 8 total`;

const MOCHA = `  7 passing (40ms)
  1 failing

  1) Parser
       handles empty input:
     AssertionError`;

const TAP = `ok 1 - one
not ok 2 - two
# pass 1
# fail 1`;

describe("test result parsing", () => {
  it("reads failing IDs and pass counts from common runners", () => {
    expect(parseTestResults(PYTEST)).toEqual({
      failing: new Set([
        "tests/components/opinet/test_geo.py::test_coordinate_conversion_loop",
        "tests/test_db.py::test_conn",
      ]),
      passed: 19,
    });
    expect(parseTestResults(VITEST)?.failing.has("src/a.test.ts > math > adds numbers")).toBe(true);
    expect(parseTestResults(VITEST)?.passed).toBe(2);
    expect(parseTestResults(JEST)?.failing.has("Suite › does a thing")).toBe(true);
    expect(parseTestResults(MOCHA)?.passed).toBe(7);
    expect(parseTestResults(TAP)).toEqual({ failing: new Set(["two"]), passed: 1 });
    expect(parseTestResults("Segmentation fault")).toBeNull();
  });

  const check = (passed: boolean, out: string): CheckResult => ({
    name: "test",
    command: "pytest",
    exit_code: passed ? 0 : 1,
    passed,
    duration_ms: 1,
    timed_out: false,
    output_tail: out,
  });
  const sb = {} as never;
  const checks = [{ name: "test" as const, argv: ["pytest"] }];

  it("treats the same pre-existing failures as verified, and new ones as a regression", async () => {
    const same = await compareWithBaseline(
      sb,
      checks,
      [check(false, PYTEST)],
      [check(false, PYTEST)],
    );
    expect(same.passed).toBe(true);
    expect(same.comparisons[0]?.sameFailures?.passed).toBe(19);

    const worse = PYTEST.replace("1 failed, 19 passed", "2 failed, 18 passed").replace(
      "ERROR tests/test_db.py",
      "FAILED tests/test_new.py::test_x - boom\nERROR tests/test_db.py",
    );
    const v = await compareWithBaseline(sb, checks, [check(false, PYTEST)], [check(false, worse)]);
    expect(v.passed).toBe(false);
    expect(v.comparisons[0]?.newFailures).toEqual(["tests/test_new.py::test_x"]);
  });
});
