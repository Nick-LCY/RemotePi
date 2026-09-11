// Vitest specs for `hash.ts` — URL hash two-field parser +
// writer + two-state dispatch (M5 §第二块 G6 / D9, M4 钉子 1 +
// 钉子 6 历史).
//
// Strategy: pure-function tests, no React or WsClient involvement.
// The hash parser / writer are the single source of truth for the
// 3-row 决策表 in App.tsx (M5 §G6 — tokenPrompt 由 App 层 token===null
// 触发，hash.ts 仅判定 work_dir × session); a regression here
// would let stale legacy hashes crash into RecoveryView or bypass
// ChoicePage level=1.
//
// Coverage follows the M4 PRD §9.5 hash-related checklist +
// M5 §D9 silent-drop requirements:
//   - All M5 hash shapes (full / work_dir+session / work_dir only /
//     empty) parse correctly.
//   - Special-character round-trips for `work_dir`:
//     `&` `#` `+` `%` space (encode/decode symmetry).
//   - Deep paths don't break parsing.
//   - decideView 决策表 — all 3 rows + boundary cases.
//   - Navigation helpers produce the right hash strings.
//   - D9 silent drop — legacy `#<token>...` parses to
//     {workDir:null, session:null} (or {workDir, session} when
//     the legacy hash also carried those segments) without
//     preserving the token.

import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_NEW,
  changeWorkDirHash,
  decideView,
  encodeHash,
  exitSessionHash,
  newSessionHash,
  readAuthFromHash,
  selectSessionHash,
  selectWorkDirHash,
} from '../hash.js';

// ---------------------------------------------------------------------------
// readAuthFromHash — parser
// ---------------------------------------------------------------------------

describe('hash — readAuthFromHash (parser)', () => {
  it('1. empty hash → all null fields (App-level token===null → TokenModal required)', () => {
    // The hash itself never carries the token post-M5; an empty
    // hash parses to {workDir:null, session:null}, which App.tsx
    // routes to <TokenModal required> via the
    // `auth.token === null` branch (D9).
    expect(readAuthFromHash('')).toEqual({
      workDir: null,
      session: null,
    });
  });

  it('2. hash with only `#` → all null (App-level token===null → TokenModal required)', () => {
    expect(readAuthFromHash('#')).toEqual({
      workDir: null,
      session: null,
    });
  });

  it('3. legacy `#<token>` (no work_dir / no session) → token dropped, both fields null (D9 silent drop)', () => {
    // M5 §D9 — the legacy M3 `#<token>` shape has no body. The
    // parser sees no `&`, so it short-circuits to all-null. The
    // token is silently dropped per the D9 contract (no field on
    // the returned model, no warning, no error). The user lands
    // on <TokenModal required> via the App-level `auth.token ===
    // null` branch — exactly the documented "旧书签 token 已失效"
    // UX.
    expect(readAuthFromHash('#abc123')).toEqual({
      workDir: null,
      session: null,
    });
  });

  it('3b. D9 silent drop — `#<token>&work_dir=<x>&session=<y>` parses without the token field', () => {
    // The M3 share-link shape with work_dir + session segments
    // attached. The parser reads everything before the first `&`
    // as the (deprecated) token position and drops it; the body
    // parses normally. The returned object has NO `token` field
    // — TypeScript would reject it at the call site if any
    // consumer tried to read `parsed.token`, which is the
    // intent (D9 forbids token preservation).
    const parsed = readAuthFromHash('#tok&work_dir=/home/me&session=sess1');
    expect(parsed).not.toHaveProperty('token');
    expect(parsed.workDir).toBe('/home/me');
    expect(parsed.session).toBe('sess1');
  });

  it('4. full two-field `work_dir=<x>&session=<y>` parses', () => {
    expect(readAuthFromHash('work_dir=/home/me&session=sess1')).toEqual({
      workDir: '/home/me',
      session: 'sess1',
    });
  });

  it('5. work_dir only → no session', () => {
    expect(readAuthFromHash('work_dir=/home/me')).toEqual({
      workDir: '/home/me',
      session: null,
    });
  });

  it('6. session only (no work_dir) parses session', () => {
    // Schema-tolerated shape — `decideView` maps this to
    // `recovery` (session is present). The PRD §4.1 doesn't
    // forbid skipping `work_dir` and using a session key
    // directly; M4 ChoicePage doesn't expose such a flow but
    // the parser must not blow up if a hand-crafted link has it.
    expect(readAuthFromHash('session=sess1')).toEqual({
      workDir: null,
      session: 'sess1',
    });
  });

  it('7. work_dir + session=new (pending placeholder)', () => {
    expect(
      readAuthFromHash(`work_dir=/home/me&session=${SESSION_NEW}`),
    ).toEqual({
      workDir: '/home/me',
      session: SESSION_NEW,
    });
  });

  it('8. legacy leading whitespace is trimmed (token slot only — work_dir/session are preserved verbatim)', () => {
    // The token slot is read via `.trim()` (M3 carryover so paste
    // actions with trailing newlines don't break); body keys are
    // extracted via the body loop and their values are NOT
    // trimmed (whitespace inside the value is a literal). A
    // legacy `#  abc  ` (token = "  abc  ") parses to all-null.
    expect(readAuthFromHash('#  abc  ')).toEqual({
      workDir: null,
      session: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Special-character round-trips (PRD §钉子 1 边界)
// ---------------------------------------------------------------------------

describe('hash — special-character round-trips (PRD §钉子 1 边界)', () => {
  it('10. space in work_dir is URL-encoded and decoded back', () => {
    const raw = `work_dir=${encodeURIComponent('/Users/foo bar/')}`;
    expect(readAuthFromHash(raw)).toEqual({
      workDir: '/Users/foo bar/',
      session: null,
    });
  });

  it('11. ampersand `&` in work_dir survives round-trip', () => {
    const raw = `work_dir=${encodeURIComponent('/mnt/data&backup/')}`;
    expect(readAuthFromHash(raw)).toEqual({
      workDir: '/mnt/data&backup/',
      session: null,
    });
  });

  it('12. plus `+` in work_dir survives round-trip', () => {
    const raw = `work_dir=${encodeURIComponent('/opt/a+b')}`;
    expect(readAuthFromHash(raw)).toEqual({
      workDir: '/opt/a+b',
      session: null,
    });
  });

  it('13. percent `%` in work_dir survives round-trip', () => {
    const raw = `work_dir=${encodeURIComponent('/tmp/100%done')}`;
    expect(readAuthFromHash(raw)).toEqual({
      workDir: '/tmp/100%done',
      session: null,
    });
  });

  it('14. hash `#` in work_dir survives round-trip', () => {
    // The work_dir is in the body, not the URL fragment, so a `#`
    // inside it is just a literal character. encodeURIComponent
    // escapes it as `%23`.
    const raw = `work_dir=${encodeURIComponent('/tmp/weird#name')}`;
    expect(readAuthFromHash(raw)).toEqual({
      workDir: '/tmp/weird#name',
      session: null,
    });
  });

  it('15. session key with `&` is URL-encoded and parsed cleanly', () => {
    const raw = `work_dir=/home/me&session=${encodeURIComponent('sess&A')}`;
    expect(readAuthFromHash(raw)).toEqual({
      workDir: '/home/me',
      session: 'sess&A',
    });
  });

  it('16. deep path (PRD §9.5 极深路径长度) parses without truncation', () => {
    const deep = '/a/very/deep/path/' + Array.from({ length: 20 }, (_, i) => `segment${i}`).join('/');
    const raw = `work_dir=${encodeURIComponent(deep)}`;
    expect(readAuthFromHash(raw)).toEqual({
      workDir: deep,
      session: null,
    });
  });

  it('16b. session containing `+` round-trips (encode + decode symmetry)', () => {
    const encoded = encodeHash({ workDir: '/h', session: 'a+b' });
    expect(readAuthFromHash(encoded)).toEqual({
      workDir: '/h',
      session: 'a+b',
    });
  });

  it('16c. session containing `%` round-trips', () => {
    const encoded = encodeHash({ workDir: '/h', session: 'a%20b' });
    expect(readAuthFromHash(encoded)).toEqual({
      workDir: '/h',
      session: 'a%20b',
    });
  });

  it('16d. session containing space round-trips (encoded as %20)', () => {
    const encoded = encodeHash({ workDir: '/h', session: 'sess 1' });
    // write side: encodeURIComponent replaces spaces with %20
    expect(encoded).toContain('session=sess%201');
    expect(readAuthFromHash(encoded).session).toBe('sess 1');
  });
});

// ---------------------------------------------------------------------------
// Defensive parsing — unknown keys + malformed values
// ---------------------------------------------------------------------------

describe('hash — defensive parsing', () => {
  it('17. unknown keys are silently dropped (forward-compat)', () => {
    expect(readAuthFromHash('work_dir=/h&future_key=foo&session=s1')).toEqual({
      workDir: '/h',
      session: 's1',
    });
  });

  it('18. missing value (`work_dir=`) is treated as missing key', () => {
    expect(readAuthFromHash('work_dir=&session=s1')).toEqual({
      workDir: null,
      session: 's1',
    });
  });

  it('19. malformed percent-encoding is dropped without throwing', () => {
    // `%ZZ` is not a valid escape; decodeURIComponent throws
    // URIError. The parser catches and returns null for the field.
    expect(() => readAuthFromHash('work_dir=%ZZ%QQ')).not.toThrow();
    expect(readAuthFromHash('work_dir=%ZZ%QQ')).toEqual({
      workDir: null,
      session: null,
    });
  });

  it('20. empty work_dir (`work_dir=`) when alone keeps session', () => {
    expect(readAuthFromHash('work_dir=')).toEqual({
      workDir: null,
      session: null,
    });
  });

  it('20b. legacy `&#work_dir=/h` — the body literally starts with `#`-bearing value', () => {
    // The M3 `#<token>` slot is read as everything before the
    // first `&`. When the body literally starts with `#`, that's
    // just a body character (the `#` was already consumed at
    // hash-start to delimit the fragment). The body key=
    // `work_dir=%23...` decodes to the work_dir value.
    const path = '/srv/build#1/data';
    const raw = `work_dir=${encodeURIComponent(path)}&session=s`;
    expect(readAuthFromHash(raw)).toEqual({
      workDir: path,
      session: 's',
    });
  });
});

// ---------------------------------------------------------------------------
// encodeHash — writer (round-trip property)
// ---------------------------------------------------------------------------

describe('hash — encodeHash (writer) round-trips', () => {
  it('21. round-trip full two-field', () => {
    const encoded = encodeHash({ workDir: '/h', session: 's' });
    expect(readAuthFromHash(encoded)).toEqual({
      workDir: '/h',
      session: 's',
    });
  });

  it('22. round-trip special-character work_dir', () => {
    const original = {
      workDir: '/Users/foo bar/&+%/more#weird',
      session: 's',
    };
    const encoded = encodeHash(original);
    expect(readAuthFromHash(encoded)).toEqual(original);
  });

  it('23. omitting work_dir / session produces shorter hash', () => {
    expect(encodeHash({})).toBe('');
    expect(encodeHash({ workDir: '/h' })).toBe('work_dir=%2Fh');
  });

  it('24. null / undefined / empty-string for optional fields are omitted', () => {
    expect(encodeHash({ workDir: null, session: undefined })).toBe('');
    expect(encodeHash({ workDir: '' })).toBe('');
  });

  it('24b. D9 — encodeHash takes NO token field (TypeScript rejects `token:` at compile time)', () => {
    // Compile-time pin: the writer signature is `AuthToHash = {
    // workDir?, session? }`. There is no `token` slot. A
    // regression that re-introduced a token field would surface
    // here as a type error in test source.
    const encoded = encodeHash({ workDir: '/h', session: 's' });
    expect(encoded).not.toContain('token');
  });

  it('25. encodeHash writes `session=new` for the new-session pending', () => {
    const encoded = newSessionHash('/home/me');
    expect(encoded).toBe(`work_dir=${encodeURIComponent('/home/me')}&session=new`);
    expect(readAuthFromHash(encoded)).toEqual({
      workDir: '/home/me',
      session: 'new',
    });
  });
});

// ---------------------------------------------------------------------------
// decideView — 3-row 决策表 (M5 §G6 — tokenPrompt 由 App 层触发)
// ---------------------------------------------------------------------------

describe('hash — decideView (M5 §G6 决策表 — 3 rows)', () => {
  it('26. no work_dir, no session → choiceLevel1', () => {
    // Note: the M3 `tokenPrompt` row is GONE — App-level
    // `auth.token === null` handles that before `decideView`
    // is called. `decideView` operates only on work_dir ×
    // session.
    expect(decideView({ workDir: null, session: null })).toBe('choiceLevel1');
  });

  it('27. work_dir only → choiceLevel2', () => {
    expect(decideView({ workDir: '/h', session: null })).toBe('choiceLevel2');
  });

  it('28. work_dir + session → recovery', () => {
    expect(decideView({ workDir: '/h', session: 's' })).toBe('recovery');
  });

  it('29. session only (no work_dir) → recovery (degenerate but tolerated)', () => {
    // Schema-tolerated shape; App.tsx's level branch would
    // render recovery. The M4 normal flow never produces this
    // (the ChoicePage enforces the two-level order), but the
    // parser must not panic.
    expect(decideView({ workDir: null, session: 's' })).toBe('recovery');
  });

  it('30. work_dir + session=new → recovery (pending placeholder)', () => {
    expect(decideView({ workDir: '/h', session: 'new' })).toBe('recovery');
  });

  // W3 (preserved from M4 review): degenerate `session-without-workdir`
  // emits a console.warn before routing to recovery. The signal
  // is unchanged across M5; the warning text only lost the
  // "token" reference.
  it('30b. W3 — degenerate session-without-workdir emits console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = decideView({ workDir: null, session: 'stale-sess' });
    expect(view).toBe('recovery');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('session without work_dir');
    expect(message).toContain('stale bookmark');
    warn.mockRestore();
  });

  it('30c. W3 — non-degenerate shapes do NOT emit the warn (avoid noise)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    decideView({ workDir: '/h', session: 's' });
    decideView({ workDir: null, session: null });
    decideView({ workDir: '/h', session: null });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Navigation helpers (钉子 6 actions)
// ---------------------------------------------------------------------------

describe('hash — navigation helpers (钉子 6 actions)', () => {
  it('32. exitSessionHash clears session, keeps work_dir', () => {
    expect(exitSessionHash('/home/me')).toBe('work_dir=%2Fhome%2Fme');
  });

  it('33. changeWorkDirHash clears work_dir + session (no token in output)', () => {
    expect(changeWorkDirHash()).toBe('');
  });

  it('34. newSessionHash writes `&session=new` after work_dir', () => {
    const encoded = newSessionHash('/home/me');
    expect(encoded).toContain('session=new');
    expect(encoded).toBe(`work_dir=${encodeURIComponent('/home/me')}&session=new`);
  });

  it('35. selectSessionHash writes both fields with encoded work_dir', () => {
    const encoded = selectSessionHash('/Users/foo bar/', 'sess1');
    expect(encoded).toBe(
      `work_dir=${encodeURIComponent('/Users/foo bar/')}&session=sess1`,
    );
    // Round-trip sanity — special-character work_dir survives.
    expect(readAuthFromHash(encoded).workDir).toBe('/Users/foo bar/');
  });

  it('36. selectWorkDirHash writes work_dir only (no session)', () => {
    expect(selectWorkDirHash('/home/me')).toBe('work_dir=%2Fhome%2Fme');
  });

  it('36b. D9 — none of the navigation helpers accept a token argument', () => {
    // Compile-time pin: the helpers' signatures are pure
    // `(workDir?, sessionKey?)` with no token slot. A
    // regression that re-introduced the token would surface
    // here as a type error.
    expect(typeof exitSessionHash).toBe('function');
    expect(exitSessionHash.length).toBe(1);
    expect(typeof changeWorkDirHash).toBe('function');
    expect(changeWorkDirHash.length).toBe(0);
    expect(typeof newSessionHash).toBe('function');
    expect(newSessionHash.length).toBe(1);
    expect(typeof selectSessionHash).toBe('function');
    expect(selectSessionHash.length).toBe(2);
    expect(typeof selectWorkDirHash).toBe('function');
    expect(selectWorkDirHash.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Decision-table driven dispatch (hash + decideView combined)
// ---------------------------------------------------------------------------

describe('hash — decision-table end-to-end', () => {
  it('37. M5 empty hash (no token in URL) → choiceLevel1', () => {
    // The user has their token in localStorage (not in the URL
    // hash) and hasn't picked a work_dir yet — they land on
    // ChoicePage level=1.
    const auth = readAuthFromHash('');
    expect(decideView(auth)).toBe('choiceLevel1');
  });

  it('38. F5 with full hash → recovery directly (skip choice pages)', () => {
    const auth = readAuthFromHash('work_dir=/h&session=s');
    expect(decideView(auth)).toBe('recovery');
  });

  it('39. work_dir only → choiceLevel2', () => {
    const fromLevel1 = readAuthFromHash('work_dir=/h');
    expect(decideView(fromLevel1)).toBe('choiceLevel2');
  });

  it('40. selecting session from level=2 produces recovery hash', () => {
    const fromLevel2 = readAuthFromHash('work_dir=/h');
    expect(decideView(fromLevel2)).toBe('choiceLevel2');
    const selectHash = selectSessionHash(fromLevel2.workDir!, 's');
    const nextAuth = readAuthFromHash(selectHash);
    expect(decideView(nextAuth)).toBe('recovery');
  });

  it('41. exiting session from level=2 produces level=2 hash (work_dir retained)', () => {
    const fromLevel2 = readAuthFromHash('work_dir=/h&session=s');
    expect(decideView(fromLevel2)).toBe('recovery');
    const exitHash = exitSessionHash(fromLevel2.workDir!);
    const nextAuth = readAuthFromHash(exitHash);
    expect(decideView(nextAuth)).toBe('choiceLevel2');
  });

  it('42. changing work_dir from level=2 produces a hash that routes to choiceLevel1', () => {
    const changeHash = changeWorkDirHash();
    const nextAuth = readAuthFromHash(changeHash);
    expect(decideView(nextAuth)).toBe('choiceLevel1');
  });
});
