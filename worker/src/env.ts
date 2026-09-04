// Worker-wide environment binding surface. The DO class and the worker entry
// both read `env.ROOM` — the binding is declared in wrangler.toml and routed
// here so both files share one source of truth.
//
// The DO concrete class (`Room`) is exported alongside the binding so wrangler's
// module-discovery picks it up automatically — wrangler scans the module graph
// for `export class <class_name>` matching each `[[durable_objects.bindings]]`
// entry (`class_name = "Room"` here).
export interface Env {
  ROOM: DurableObjectNamespace;
}

export { Room } from './room.js';