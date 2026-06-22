import {
  BaseDriver,
  Capability,
  OperationNotSupportedError,
  type DriverOptions,
  type Environment,
  type ListOptions,
  type PutData,
  type PutOptions,
  type StorageEntry,
} from "@rocketbean/genera";

/**
 * Starter template for a Genera driver.
 *
 * To author a new provider:
 *   1. Copy this package to `packages/genera-<provider>` and rename it.
 *   2. Add the provider SDK as a `peerDependency` (keep the core dependency-light).
 *   3. Set the `TNative` type parameter to the SDK's client type.
 *   4. Implement the five core methods + the escape-hatch members below.
 *   5. Advertise extended operations in `capabilities` and implement the matching
 *      optional methods (copy/move/stat/getSignedUrl/…).
 *   6. Certify it:
 *        import { describeConformance } from "@rocketbean/genera/conformance";
 *        describeConformance("MyDriver", () => new TemplateDriver());
 */
export interface TemplateDriverOptions extends DriverOptions {
  /** Example provider option — replace with your SDK's real configuration. */
  readonly endpoint?: string;
}

const TODO = "TemplateDriver: implement this method for your provider";

export class TemplateDriver extends BaseDriver</* TNative */ unknown> {
  readonly capabilities: ReadonlySet<Capability> = new Set();
  readonly environments: ReadonlySet<Environment> = new Set<Environment>([
    "node",
    "browser",
  ]);

  constructor(options: TemplateDriverOptions = {}) {
    super(options);
  }

  get native(): unknown {
    throw new OperationNotSupportedError(TODO);
  }

  put(_path: string, _data: PutData, _opts?: PutOptions): Promise<StorageEntry> {
    throw new OperationNotSupportedError(TODO);
  }

  get(_path: string): Promise<Uint8Array> {
    throw new OperationNotSupportedError(TODO);
  }

  list(_prefix?: string, _opts?: ListOptions): AsyncIterable<StorageEntry> {
    throw new OperationNotSupportedError(TODO);
  }

  delete(_path: string): Promise<void> {
    throw new OperationNotSupportedError(TODO);
  }

  exists(_path: string): Promise<boolean> {
    throw new OperationNotSupportedError(TODO);
  }

  resolveNativeId(_path: string): Promise<string> {
    throw new OperationNotSupportedError(TODO);
  }
}
