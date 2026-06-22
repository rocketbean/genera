/**
 * Node-only entry point (`@rocketbean/genera/node`).
 *
 * The default entry (`@rocketbean/genera`) is isomorphic and pulls in no Node
 * built-ins. Drivers that depend on `node:*` modules — like the local-filesystem
 * driver — live here so they never leak into a browser bundle (plan §5.3, §5.6).
 */
export { FsDriver, type FsDriverOptions } from "./drivers/fs";
