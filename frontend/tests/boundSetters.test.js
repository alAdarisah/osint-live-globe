// A state setter that no longer exists.
//
// IntelPanel.jsx called `setCollapsed(false)` for weeks after the rail stopped
// folding and its `collapsed` state was deleted. The suite could not see it:
// there is no bundler step to fail, no types, and the line sits inside an effect
// that only runs when a country is selected -- so it was a ReferenceError waiting
// on a specific click, and the click took the whole app down to the crash screen.
//
// The signature of that failure is mechanical: the identifier appears in the file
// exactly once, in call position, and nowhere else. A setter that is real is
// always *bound* somewhere first -- `const [x, setX] = useState()`, a destructured
// prop, an import -- and none of those put a `(` after the name. So an identifier
// whose every appearance is a call is an identifier nothing ever gave a value.
//
// Deliberately narrow. It is not a type checker and does not try to be; it
// catches one shape of one mistake, which is the shape that shipped.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const resolvePath = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** Comments and string/template literals blanked, so prose and error text cannot
 *  masquerade as code. Length is preserved so line numbers still line up. */
function blankNonCode(source) {
  const keepLines = (m) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + keepLines(m.slice(lead.length)))
    .replace(/`(?:\\.|[^`\\])*`/g, keepLines)
    .replace(/"(?:\\.|[^"\\\n])*"/g, keepLines)
    .replace(/'(?:\\.|[^'\\\n])*'/g, keepLines);
}

/** Every .js/.jsx file under src/, as [relative name, text]. */
function sources() {
  const root = resolvePath("../src");
  const out = [];
  for (const entry of readdirSync(root, { recursive: true })) {
    const rel = entry.toString().replace(/\\/g, "/");
    if (!/\.jsx?$/.test(rel)) continue;
    out.push([rel, readFileSync(path.join(root, rel), "utf8")]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

// Timer names happen to fit the shape and are the platform's, not ours.
const GLOBALS = new Set(["setTimeout", "setInterval", "setImmediate"]);

test("every setter that is called is also bound", () => {
  const offenders = [];

  for (const [name, raw] of sources()) {
    const code = blankNonCode(raw);

    // Bare `setSomething(` -- not `foo.setSomething(`, which is a method on an
    // object this file did not have to declare.
    const called = new Map();
    for (const m of code.matchAll(/(^|[^\w.$])(set[A-Z][\w$]*)\s*\(/g)) {
      const identifier = m[2];
      if (GLOBALS.has(identifier)) continue;
      if (!called.has(identifier)) called.set(identifier, code.slice(0, m.index).split("\n").length);
    }

    for (const [identifier, line] of called) {
      // Two bindings whose name is also followed by `(`, so they have to be
      // recognised before the call/non-call split below: a plain function
      // declaration, and an object-literal method shorthand -- which is how the
      // map controller publishes most of its API (`setInfraFilter(text) { … }`).
      if (new RegExp(`function\\s+${identifier}\\s*\\(`).test(code)) continue;
      if (new RegExp(`^\\s*${identifier}\\s*\\([^)]*\\)\\s*\\{`, "m").test(code)) continue;

      // Every appearance of the name, call or not. One that is not a call is a
      // binding: `const [x, setX] = useState()`, a destructured prop, an import,
      // an assignment, a prop passed on.
      const uses = [...code.matchAll(new RegExp(`(^|[^\\w.$])${identifier}\\b(\\s*\\()?`, "g"))];
      const bound = uses.some((use) => !use[2]);
      if (!bound) offenders.push(`${name}:${line}: ${identifier} is called but never bound in this file`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a setter is called that nothing in the file declares, imports or receives as a prop. " +
    `That is a ReferenceError the moment the line runs:\n${offenders.join("\n")}`,
  );
});
