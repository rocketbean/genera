import { describeConformance } from "../src/conformance";
import { MemoryDriver } from "../src/index";

/**
 * The isomorphism proof (plan Phase 5): the MemoryDriver — and therefore the core
 * path engine, capability dispatch, error taxonomy, and `toBytes` — must pass the
 * full conformance kit in a real browser, not just Node. Any leak of a Node
 * built-in (`fs`/`path`/`Buffer`/`process`) into the core fails this run.
 *
 * Gated on the driver's own `environments` declaration so the suite stays honest.
 */
const probe = new MemoryDriver();
if (probe.environments.has("browser")) {
  describeConformance("Memory (browser)", () => new MemoryDriver());
}
