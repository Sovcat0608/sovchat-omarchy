import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoFile = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Omarchy signup is open and sends no access code", async () => {
  const [loginForm, validators] = await Promise.all([
    repoFile("components/login-form.tsx"),
    repoFile("lib/validators.ts")
  ]);

  assert.match(
    loginForm,
    /mode === "signup" \? "\/api\/auth\/signup" : "\/api\/auth\/login"/u
  );
  assert.match(
    loginForm,
    /signupSchema\.safeParse\(\{\s*email,\s*password,\s*nickname\s*\}\)/su
  );
  assert.doesNotMatch(loginForm, /betaAccessCode|beta access code/iu);
  assert.doesNotMatch(validators, /betaAccessCode|betaAccessRequestSchema|beta access code/iu);
});

test("documentation assigns the 500-account ceiling to the server", async () => {
  const [readme, handover] = await Promise.all([
    repoFile("README.md"),
    repoFile("HANDOVER.md")
  ]);

  assert.match(readme, /anyone can sign up/iu);
  assert.match(readme, /server-enforced 500-account/iu);
  assert.match(handover, /server-enforced global capacity of 500\s+accounts/iu);
  assert.match(handover, /no access code/iu);
  assert.match(handover, /capacity enforcement belong only to the Windows\/control-plane/iu);
});
