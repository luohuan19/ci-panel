import { describe, expect, it } from "vitest";
import { ProvisionError, redactTokenArgs } from "../../src/service/runner_provision";

// The GitHub registration token is a live credential: whoever holds it can register a runner
// against the repository. redactTokenArgs is the only thing keeping it out of
// ProvisionError.fullLog, which travels through BatchItemState.log all the way to the browser.
//
// Placeholder values only — this is a public repository.
const TOKEN = "PLACEHOLDER_REGISTRATION_TOKEN";
const REPO_URL = "https://github.com/example-org/example-repo";

// The real argument list from provisionRunner, kept in the same order.
const realArgs = (token: string) => [
  "--url",
  REPO_URL,
  "--token",
  token,
  "--name",
  "runner-1",
  "--work",
  "_work",
  "--unattended",
  "--replace"
];

describe("redactTokenArgs", () => {
  it("replaces the value following --token", () => {
    const out = redactTokenArgs(realArgs(TOKEN));
    expect(out).not.toContain(TOKEN);
    expect(out[out.indexOf("--token") + 1]).toBe("***");
  });

  it("leaves every other argument intact", () => {
    const out = redactTokenArgs(realArgs(TOKEN));
    expect(out).toEqual([
      "--url",
      REPO_URL,
      "--token",
      "***",
      "--name",
      "runner-1",
      "--work",
      "_work",
      "--unattended",
      "--replace"
    ]);
  });

  it("survives --labels being appended", () => {
    const withLabels = [...realArgs(TOKEN), "--labels", "linux,arm64"];
    const out = redactTokenArgs(withLabels);
    expect(out).not.toContain(TOKEN);
    expect(out.slice(-2)).toEqual(["--labels", "linux,arm64"]);
  });

  it("redacts every occurrence, not just the first", () => {
    const out = redactTokenArgs(["--token", TOKEN, "--token", TOKEN]);
    expect(out.join(" ")).not.toContain(TOKEN);
    expect(out).toEqual(["--token", "***", "--token", "***"]);
  });

  it("handles the degenerate shapes without throwing", () => {
    expect(redactTokenArgs([])).toEqual([]);
    expect(redactTokenArgs(["--token"])).toEqual(["--token"]); // nothing follows it
    expect(redactTokenArgs([TOKEN])).toEqual([TOKEN]); // no --token precedes it
  });

  it("matches by POSITION, so a renamed flag stops redacting", () => {
    // Documents the failure mode rather than hiding it. The token is a random string with no
    // recognisable shape, so content matching is not available — position is all there is.
    // If the flag is ever renamed, this is where it silently stops working, and the two
    // assertions above ("replaces the value following --token") go red at the same time.
    const renamed = ["--registration-token", TOKEN];
    expect(redactTokenArgs(renamed)).toContain(TOKEN);
  });

  it("does not mutate the caller's array", () => {
    const args = realArgs(TOKEN);
    redactTokenArgs(args);
    expect(args[3]).toBe(TOKEN);
  });
});

describe("ProvisionError.fullLog", () => {
  it("carries the redacted command line, never the raw token", () => {
    // Mirrors the construction at the config.sh failure branch.
    const safeArgs = redactTokenArgs(realArgs(TOKEN));
    const err = new ProvisionError(
      "config.sh 注册失败 (code=1)",
      `$ config.sh ${safeArgs.join(" ")}\n(cwd: /tmp/x)\nexit code: 1\n\nsome output`
    );
    expect(err.fullLog).not.toContain(TOKEN);
    expect(err.fullLog).toContain("--token ***");
    expect(err.name).toBe("ProvisionError");
  });

  it("cannot scrub a token that config.sh itself echoed into its output", () => {
    // A boundary of this defence worth stating outright: fullLog concatenates the redacted
    // argv WITH the child's raw stdout/stderr. redactTokenArgs only touches the former. If
    // config.sh ever echoed the token back, it would still reach the browser through the
    // latter. Today it does not, and this asserts the limit rather than a guarantee.
    const err = new ProvisionError("failed", `$ config.sh --token ***\n\nUsing token ${TOKEN}`);
    expect(err.fullLog).toContain(TOKEN);
  });
});
