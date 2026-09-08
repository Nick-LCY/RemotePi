// Vitest specs for the M4 work-directory + directory-browsing payload &
// result schemas added in [[tasks/m4/02-shared-protocol-v3.md]].
//
// PRD mapping — each `it` block below is numbered to match the M4 PRD
// [[prds/m4-multi-session.md#9.1-shared-vitest-30-条]] §9.1 checklist:
//
//   4 new request payload schemas (cases 1–11 — legal/illegal/required-field
//   sweeps for each schema):
//     1.  ListDirectoriesPayloadSchema — legal with explicit `path`
//     2.  ListDirectoriesPayloadSchema — legal with `path` omitted
//         (absent → bridge falls back to `$HOME`)
//     3.  ListDirectoriesPayloadSchema — rejects non-string `path`
//     4.  WorkDirListPayloadSchema — legal empty `{}`
//     5.  WorkDirListPayloadSchema — rejects extra non-optional fields
//         (none are defined — extras are stripped by zod default policy,
//         but a non-object root must fail)
//     6.  WorkDirAddPayloadSchema — legal with `path`
//     7.  WorkDirAddPayloadSchema — rejects missing `path` (required)
//     8.  WorkDirAddPayloadSchema — rejects non-string `path`
//     9.  WorkDirRemovePayloadSchema — legal with `path`
//    10.  WorkDirRemovePayloadSchema — rejects missing `path` (required)
//    11.  WorkDirRemovePayloadSchema — rejects non-string `path`
//
//   2 new result schemas (cases 12–17 — legal + missing-field + element-shape
//   sweeps):
//    12. ListDirectoriesResultSchema — legal with populated `entries[]`
//    13. ListDirectoriesResultSchema — legal with empty `entries: []`
//    14. ListDirectoriesResultSchema — rejects missing `entries`
//    15. ListDirectoriesResultSchema — rejects element missing `name` or `path`
//    16. WorkDirListResultSchema — legal with populated `work_dirs: string[]`
//    17. WorkDirListResultSchema — rejects missing `work_dirs`
//
//   `pi/prompt.payload.work_dir` (cases 18–19 — see also `pi.test.ts` for
//   the envelope-level sweep):
//    18. PromptPayloadSchema (which carries `work_dir?`) — legal with
//        `content` + `work_dir` set (the `session:'new'` path — schema
//        does NOT enforce the `session` correlation; see ADR-0010 §决策.2)
//    19. PromptPayloadSchema — rejects non-string `work_dir`
//
// ## `pi/prompt.payload.work_dir` test location
//
// The `work_dir?` field lives directly on `PromptPayloadSchema` in
// `pi.ts` (per the `envelope.ts` header convention); the cases below
// exercise it through `PromptPayloadSchema` so the assertions line up
// with what the M4 implementation actually emits. See `pi.test.ts` for
// the envelope-level round-trip.
//
// Style: every assertion goes through `schema.safeParse(...)` (for the
// payload-only shape) and `Envelope.safeParse(...)` (for the envelope-level
// sweeps), mirroring the M2 envelope.test.ts pattern.

import { describe, expect, it } from 'vitest';
import { Envelope, PROTOCOL_VERSION } from '../envelope.js';
import { PromptPayloadSchema } from '../pi.js';
import {
  ListDirectoriesPayloadSchema,
  ListDirectoriesResultSchema,
  WorkDirAddPayloadSchema,
  WorkDirListPayloadSchema,
  WorkDirListResultSchema,
  WorkDirRemovePayloadSchema,
} from '../work-dirs.js';

// ----- helpers -----

function parseEnvelope(value: unknown) {
  return Envelope.safeParse(value);
}

describe('Work-dir request payloads (M4 PRD §9.1 — 11 cases)', () => {
  // ----- ListDirectoriesPayloadSchema (cases 1–3) -----

  it('1. parses a legal `list_directories` payload with explicit `path`', () => {
    const result = ListDirectoriesPayloadSchema.safeParse({ path: '/home/user' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.path).toBe('/home/user');
  });

  it('2. parses a legal `list_directories` payload with `path` omitted (bridge falls back to $HOME)', () => {
    // control.md §6.5: absent `path` is the "list home" form — the bridge
    // resolves to `$HOME` server-side. Schema must allow `{}` and surface
    // `path` as `undefined`.
    const result = ListDirectoriesPayloadSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.path).toBeUndefined();

    // Schema-level spot check — same outcome.
    expect(ListDirectoriesPayloadSchema.safeParse({}).success).toBe(true);

    // Envelope-level: a `list_directories` envelope with an empty payload
    // parses through the full Envelope union and narrows on the new
    // control type (ADR-0010).
    const env = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'list_directories',
      id: 'wd-002',
      payload: {},
    });
    expect(env.success).toBe(true);
  });

  it('3. rejects a `list_directories` payload whose `path` is not a string', () => {
    // Path must be a string when present; numbers / objects / booleans
    // are outside the schema. The schema declares `path: z.string().optional()`
    // so any non-string value trips the type guard.
    for (const path of [42, true, { nested: 'x' }, ['/home/user']]) {
      const result = ListDirectoriesPayloadSchema.safeParse({ path });
      expect(result.success, `path=${JSON.stringify(path)} should be rejected`).toBe(false);
    }
  });

  // ----- WorkDirListPayloadSchema (cases 4–5) -----

  it('4. parses a legal `work_dir_list` payload (always empty `{}`)', () => {
    // control.md §6.6: the web queries the bridge for the user's saved
    // work directory list with no parameters — payload is always `{}`.
    const result = WorkDirListPayloadSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({});

    // Envelope-level sweep — `work_dir_list` envelope must parse with
    // empty payload through the full ControlBranch discriminated union.
    const env = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_list',
      id: 'wd-004',
      payload: {},
    });
    expect(env.success).toBe(true);
  });

  it('5. rejects a `work_dir_list` payload whose root is not an object', () => {
    // The schema is `z.object({})` — a non-object root (`null`, string,
    // number, array) must be refused at the boundary. zod's default object
    // parser rejects `null` and primitives; arrays of length 0 happen to
    // parse as `{}` only in strict mode (here they do NOT — `[]` is not
    // an object literal). Sweep the four outright non-object roots.
    for (const root of [null, 'string', 42, true]) {
      const result = WorkDirListPayloadSchema.safeParse(root);
      expect(result.success, `root=${JSON.stringify(root)} should be rejected`).toBe(false);
    }

    // Strip-contract pin — `WorkDirListPayloadSchema` is `z.object({})`;
    // zod's default object policy strips unknown keys (mirrors the
    // `AbortPayload` case 16 precedent in `pi.test.ts`). A `{ extra: 'x' }`
    // input parses successfully and the resulting `data` is exactly `{}`,
    // pinning the contract that unknown keys never leak through this
    // payload surface.
    const stripped = WorkDirListPayloadSchema.safeParse({ extra: 'x' });
    expect(stripped.success).toBe(true);
    if (!stripped.success) return;
    expect(stripped.data).toEqual({});
  });

  // ----- WorkDirAddPayloadSchema (cases 6–8) -----

  it('6. parses a legal `work_dir_add` payload with `path`', () => {
    const result = WorkDirAddPayloadSchema.safeParse({ path: '/home/user/proj' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.path).toBe('/home/user/proj');

    // Envelope-level — round-trip through `Envelope.safeParse`.
    const env = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_add',
      id: 'wd-006',
      payload: { path: '/home/user/proj' },
    });
    expect(env.success).toBe(true);
  });

  it('7. rejects a `work_dir_add` payload missing `path`', () => {
    // `path` is required by control.md §6.7 — the bridge must reject any
    // add request that does not specify a directory to add.
    const result = WorkDirAddPayloadSchema.safeParse({});
    expect(result.success).toBe(false);

    // Schema-level spot check with empty string also fails since the
    // schema declares `path: z.string()` (no `min(1)` on this field, but
    // empty strings are still strings — the test is structural).
    // The key contract here is "missing", so case 8 covers the
    // non-string-type branch.
  });

  it('8. rejects a `work_dir_add` payload whose `path` is not a string', () => {
    // Required + string-typed. Numbers, objects, booleans, arrays must
    // all be refused at the boundary.
    for (const path of [42, true, { absolute: true }, null]) {
      const result = WorkDirAddPayloadSchema.safeParse({ path });
      expect(result.success, `path=${JSON.stringify(path)} should be rejected`).toBe(false);
    }
  });

  // ----- WorkDirRemovePayloadSchema (cases 9–11) -----

  it('9. parses a legal `work_dir_remove` payload with `path`', () => {
    const result = WorkDirRemovePayloadSchema.safeParse({ path: '/tmp/old-proj' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.path).toBe('/tmp/old-proj');

    // Envelope-level — round-trip through `Envelope.safeParse`.
    const env = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'control',
      type: 'work_dir_remove',
      id: 'wd-009',
      payload: { path: '/tmp/old-proj' },
    });
    expect(env.success).toBe(true);
  });

  it('10. rejects a `work_dir_remove` payload missing `path`', () => {
    const result = WorkDirRemovePayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('11. rejects a `work_dir_remove` payload whose `path` is not a string', () => {
    for (const path of [42, true, { absolute: true }, null]) {
      const result = WorkDirRemovePayloadSchema.safeParse({ path });
      expect(result.success, `path=${JSON.stringify(path)} should be rejected`).toBe(false);
    }
  });
});

describe('Work-dir result schemas (M4 PRD §9.1 — 6 cases)', () => {
  // ----- ListDirectoriesResultSchema (cases 12–15) -----

  it('12. parses a legal `list_directories` result with populated `entries[]`', () => {
    // The reply `result.data` carries `{ entries: { name, path }[] }`.
    // The outer envelope parses with `data: z.unknown()` (control.ts) so
    // the consumer narrows on `reply_to` and revalidates `data` against
    // this schema before reading any field.
    const result = ListDirectoriesResultSchema.safeParse({
      entries: [
        { name: 'projects', path: '/home/user/projects' },
        { name: 'dotfiles', path: '/home/user/dotfiles' },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries).toHaveLength(2);
    expect(result.data.entries[0]?.name).toBe('projects');
    expect(result.data.entries[0]?.path).toBe('/home/user/projects');
  });

  it('13. accepts a `list_directories` result with an empty `entries: []`', () => {
    // An empty directory listing is a legitimate result (e.g. an empty
    // home directory or a directory with only hidden files that the
    // bridge chooses to omit). The schema's `z.array(...)` accepts `[]`.
    const result = ListDirectoriesResultSchema.safeParse({ entries: [] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries).toEqual([]);
  });

  it('14. rejects a `list_directories` result missing `entries`', () => {
    // `entries` is required by control.md §6.5 — the result shape is
    // pinned so the web can always iterate `data.entries`.
    const result = ListDirectoriesResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('15. rejects a `list_directories` result whose entries element is missing `name` or `path`', () => {
    // Each entry is `{ name: string, path: string }`. An element that
    // omits either field is malformed and must be refused so the web
    // never reads `undefined`.
    for (const entries of [
      [{ name: 'only-name' }], // missing `path`
      [{ path: '/only/path' }], // missing `name`
      [{}], // missing both
      [{ name: 'p', path: '/x', extra: 'ok' }], // legal — extras stripped by zod default
    ]) {
      const result = ListDirectoriesResultSchema.safeParse({ entries });
      if (entries[0] && 'extra' in (entries[0] as Record<string, unknown>)) {
        // The 4th fixture is intentionally legal — extras are stripped.
        expect(
          result.success,
          `entries=${JSON.stringify(entries)} should parse (extras stripped)`,
        ).toBe(true);
      } else {
        expect(result.success, `entries=${JSON.stringify(entries)} should be rejected`).toBe(false);
      }
    }
  });

  // ----- WorkDirListResultSchema (cases 16–17) -----

  it('16. parses a legal `work_dir_list` result with populated `work_dirs: string[]`', () => {
    const result = WorkDirListResultSchema.safeParse({
      work_dirs: ['/home/user/proj-a', '/home/user/proj-b'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.work_dirs).toEqual(['/home/user/proj-a', '/home/user/proj-b']);

    // An empty list is also a legal result (no saved work dirs yet).
    const empty = WorkDirListResultSchema.safeParse({ work_dirs: [] });
    expect(empty.success).toBe(true);
  });

  it('17. rejects a `work_dir_list` result missing `work_dirs`', () => {
    const result = WorkDirListResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('pi/prompt.payload.work_dir (M4 PRD §9.1 — 2 cases)', () => {
  // ----- PromptPayloadSchema work_dir field (cases 18–19) -----

  it('18. parses a legal `pi/prompt` payload with `work_dir` set (the `session:"new"` path)', () => {
    // Wire contract (ADR-0010 §决策.2 + pi.ts JSDoc): `work_dir` MUST
    // only be carried by prompts whose envelope `session === 'new'`. The
    // shared schema enforces ONLY the optional-side of the contract
    // (presence is allowed; absence is allowed) — the "new only" rule is
    // a bridge-side convention that the web is responsible for honouring.
    // This case asserts the presence-legality half of that contract;
    // absence is covered by the existing `pi.test.ts` cases 1 + 11
    // (legal payload without work_dir / rejected payload missing
    // content).
    const result = PromptPayloadSchema.safeParse({
      content: 'start a new session here',
      work_dir: '/home/user/proj-new',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.content).toBe('start a new session here');
    expect(result.data.work_dir).toBe('/home/user/proj-new');

    // Envelope-level — round-trip through `Envelope.safeParse` with a
    // `session: 'new'` envelope to demonstrate the canonical M4 wire
    // frame the web emits at ChoicePage (level=2 → "start new session").
    const env = parseEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'pi',
      type: 'prompt',
      id: 'wd-018',
      session: 'new',
      payload: {
        content: 'start a new session here',
        work_dir: '/home/user/proj-new',
      },
    });
    expect(env.success).toBe(true);
  });

  it('19. rejects a `pi/prompt` payload whose `work_dir` is not a string', () => {
    // Optional but typed — non-string values trip the type guard. The
    // `content` field is also required (existing behaviour), so a bare
    // `{ content }` parses fine; a non-string `work_dir` does not.
    for (const work_dir of [42, true, { absolute: true }, ['/x']]) {
      const result = PromptPayloadSchema.safeParse({
        content: 'hi',
        work_dir,
      });
      expect(result.success, `work_dir=${JSON.stringify(work_dir)} should be rejected`).toBe(false);
    }
  });
});
