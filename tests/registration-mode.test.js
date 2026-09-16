import test from "node:test";
import assert from "node:assert/strict";

import { shouldSkipRuntimeRegistration } from "../src/registration-mode.js";

test("CLI metadata discovery stays side-effect-free", () => {
  assert.equal(shouldSkipRuntimeRegistration("cli-metadata"), true);
  assert.equal(shouldSkipRuntimeRegistration("full"), false);
  assert.equal(shouldSkipRuntimeRegistration(undefined), false);
});
