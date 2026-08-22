/**
 * mcAI core — pure, dependency-free, isomorphic.
 *
 * Nothing in here touches the network, the filesystem, or a Minecraft server.
 * That is deliberate: the same code compiles blueprints on the daemon, in the
 * CLI, in tests, and in the browser dashboard's live preview.
 */

export * from './types.js';
export * from './geometry.js';
export * from './rng.js';
export * from './blocks.js';
export * from './voxel.js';
export * from './palette.js';
export * from './blueprint.js';
export * from './compile.js';
export * from './prefabs.js';
export * from './render.js';
export * as shapes from './shapes.js';

export const VERSION = '5.0.0';
