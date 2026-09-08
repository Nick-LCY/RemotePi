// Vitest specs for `hash.ts` — URL hash three-field parser +
// writer + three-state dispatch (M4 钉子 1 + 钉子 6, tasks/m4/07).
//
// Strategy: pure-function tests, no React or WsClient involvement.
// The hash parser / writer are the single source of truth for the
// 4-row 决策表 in App.tsx; a regression here would let stale
// legacy hashes crash into RecoveryView or bypass ChoicePage level=1.
//
// Coverage follows the M4 PRD §9.5 hash-related checklist:
//   - All hash shapes (full / token+work_dir / token+session / token
//     only / token+work_dir+session=new) parse correctly.
//   - Special-character round-trips for `work_dir`:
//     `&` `#` `+` `%` space (encode/decode symmetry).
//   - Deep paths don't break parsing.
//   - decideView 决策表 — all 4 rows + boundary cases.
//   - Navigation helpers produce the right hash strings.
//   - M3 legacy compatibility: `#<token>` parses as
//     { token, workDir: null, session: null }.

import { describe, expect, it } from 'vitest';

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
  it('1. empty hash → all null fields (tokenPrompt path)', () => {
    expect(readAuthFromHash('')).toEqual({
      token: null,
      workDir: null,
      session: null,
    });
  });

  it('2. hash with only `#` → all null (tokenPrompt path)', () => {
    expect(readAuthFromHash('#')).toEqual({
      token: null,
      workDir: null,
      session: null,
    });
  });

  it('3. M3 legacy `#<token>` → token only, no work_dir / no session', () => {
    expect(readAuthFromHash('#abc123')).toEqual({
      token: 'abc123',
      workDir: null,
      session: null,
    });
  });

  it('4. full three-field `#<token>&work_dir=<x>&session=<y>` parses', () => {
    expect(readAuthFromHash('#tok&work_dir=/home/me&session=sess1')).toEqual({
      token: 'tok',
      workDir: '/home/me',
      session: 'sess1',
    });
  });

  it('5. token + work_dir only → no session', () => {
    expect(readAuthFromHash('#tok&work_dir=/home/me')).toEqual({
      token: 'tok',
      workDir: '/home/me',
      session: null,
    });
  });

  it('6. token + session only (no work_dir!) parses both', () => {
    // Schema-tolerated shape — `decideView` maps this to `recovery`
    // (session is present). The PRD §4.1 doesn't forbid skipping
    // `work_dir` and using a session key directly; M4 ChoicePage
    // doesn't expose such a flow but the parser must not blow up
    // if a hand-crafted link has it.
    expect(readAuthFromHash('#tok&session=sess1')).toEqual({
      token: 'tok',
      workDir: null,
      session: 'sess1',
    });
  });

  it('7. token + work_dir + session=new (pending placeholder)', () => {
    expect(
      readAuthFromHash(`#tok&work_dir=/home/me&session=${SESSION_NEW}`),
    ).toEqual({
      token: 'tok',
      workDir: '/home/me',
      session: SESSION_NEW,
    });
  });

  it('8. leading/trailing whitespace on token is trimmed', () => {
    expect(readAuthFromHash('#  abc123  ')).toEqual({
      token: 'abc123',
      workDir: null,
      session: null,
    });
  });

  it('9. token with internal whitespace is preserved verbatim (M3 contract)', () => {
    // The M3 token is alphanumeric + dash only — but we don't
    // validate the token's alphabet here; a malformed token still
    // passes the parser and is rejected later by the worker
    // handshake. This test pins the "no internal trim" behaviour.
    expect(readAuthFromHash('#abc 123')).toEqual({
      token: 'abc 123',
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
    const raw = `#tok&work_dir=${encodeURIComponent('/Users/foo bar/')}`;
    expect(readAuthFromHash(raw)).toEqual({
      token: 'tok',
      workDir: '/Users/foo bar/',
      session: null,
    });
  });

  it('11. ampersand `&` in work_dir survives round-trip', () => {
    const raw = `#tok&work_dir=${encodeURIComponent('/mnt/data&backup/')}`;
    expect(readAuthFromHash(raw)).toEqual({
      token: 'tok',
      workDir: '/mnt/data&backup/',
      session: null,
    });
  });

  it('12. plus `+` in work_dir survives round-trip', () => {
    const raw = `#tok&work_dir=${encodeURIComponent('/opt/a+b')}`;
    expect(readAuthFromHash(raw)).toEqual({
      token: 'tok',
      workDir: '/opt/a+b',
      session: null,
    });
  });

  it('13. percent `%` in work_dir survives round-trip', () => {
    const raw = `#tok&work_dir=${encodeURIComponent('/tmp/100%done')}`;
    expect(readAuthFromHash(raw)).toEqual({
      token: 'tok',
      workDir: '/tmp/100%done',
      session: null,
    });
  });

  it('14. hash `#` in work_dir survives round-trip', () => {
    // The work_dir is in the body, not the URL fragment, so a `#`
    // inside it is just a literal character. encodeURIComponent
    // escapes it as `%23`.
    const raw = `#tok&work_dir=${encodeURIComponent('/tmp/weird#name')}`;
    expect(readAuthFromHash(raw)).toEqual({
      token: 'tok',
      workDir: '/tmp/weird#name',
      session: null,
    });
  });

  it('15. session key with `&` is URL-encoded and parsed cleanly', () => {
    const raw = `#tok&work_dir=/home/me&session=${encodeURIComponent('sess&A')}`;
    expect(readAuthFromHash(raw)).toEqual({
      token: 'tok',
      workDir: '/home/me',
      session: 'sess&A',
    });
  });

  it('16. deep path (PRD §9.5 极深路径长度) parses without truncation', () => {
    const deep = '/a/very/deep/path/' + Array.from({ length: 20 }, (_, i) => `segment${i}`).join('/');
    const raw = `#tok&work_dir=${encodeURIComponent(deep)}`;
    expect(readAuthFromHash(raw)).toEqual({
      token: 'tok',
      workDir: deep,
      session: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Defensive parsing — unknown keys + malformed values
// ---------------------------------------------------------------------------

describe('hash — defensive parsing', () => {
  it('17. unknown keys are silently dropped (forward-compat)', () => {
    expect(readAuthFromHash('#tok&work_dir=/h&future_key=foo&session=s1')).toEqual({
      token: 'tok',
      workDir: '/h',
      session: 's1',
    });
  });

  it('18. missing value (`&work_dir=`) is treated as missing key', () => {
    expect(readAuthFromHash('#tok&work_dir=&session=s1')).toEqual({
      token: 'tok',
      workDir: null,
      session: 's1',
    });
  });

  it('19. malformed percent-encoding is dropped without throwing', () => {
    // `%ZZ` is not a valid escape; decodeURIComponent throws
    // URIError. The parser catches and returns null for the field.
    expect(() => readAuthFromHash('#tok&work_dir=%ZZ%QQ')).not.toThrow();
    expect(readAuthFromHash('#tok&work_dir=%ZZ%QQ')).toEqual({
      token: 'tok',
      workDir: null,
      session: null,
    });
  });

  it('20. empty work_dir (`&work_dir=`) when alone keeps token / session', () => {
    expect(readAuthFromHash('#tok&work_dir=')).toEqual({
      token: 'tok',
      workDir: null,
      session: null,
    });
  });
});

// ---------------------------------------------------------------------------
// encodeHash — writer (round-trip property)
// ---------------------------------------------------------------------------

describe('hash — encodeHash (writer) round-trips', () => {
  it('21. round-trip full three-field', () => {
    const encoded = encodeHash({ token: 'tok', workDir: '/h', session: 's' });
    expect(readAuthFromHash(encoded)).toEqual({
      token: 'tok',
      workDir: '/h',
      session: 's',
    });
  });

  it('22. round-trip special-character work_dir', () => {
    const original = {
      token: 'tok',
      workDir: '/Users/foo bar/&+%/more#weird',
      session: 's',
    };
    const encoded = encodeHash(original);
    expect(readAuthFromHash(encoded)).toEqual(original);
  });

  it('23. omitting work_dir / session produces shorter hash', () => {
    expect(encodeHash({ token: 'tok' })).toBe('tok');
    expect(encodeHash({ token: 'tok', workDir: '/h' })).toBe('tok&work_dir=%2Fh');
  });

  it('24. null / undefined / empty-string for optional fields are omitted', () => {
    expect(encodeHash({ token: 'tok', workDir: null, session: undefined })).toBe('tok');
    expect(encodeHash({ token: 'tok', workDir: '' })).toBe('tok');
  });

  it('25. encodeHash writes `&session=new` for the new-session pending', () => {
    const encoded = newSessionHash('tok', '/home/me');
    expect(encoded).toBe(`tok&work_dir=${encodeURIComponent('/home/me')}&session=new`);
    expect(readAuthFromHash(encoded)).toEqual({
      token: 'tok',
      workDir: '/home/me',
      session: 'new',
    });
  });
});

// ---------------------------------------------------------------------------
// decideView — 4-row 决策表 (钉子 6)
// ---------------------------------------------------------------------------

describe('hash — decideView (钉子 6 决策表)', () => {
  it('26. no token → tokenPrompt', () => {
    expect(decideView({ token: null, workDir: null, session: null })).toBe('tokenPrompt');
  });

  it('27. token only → choiceLevel1 (M3 legacy + new fallback)', () => {
    expect(decideView({ token: 't', workDir: null, session: null })).toBe('choiceLevel1');
  });

  it('28. token + work_dir only → choiceLevel2', () => {
    expect(decideView({ token: 't', workDir: '/h', session: null })).toBe('choiceLevel2');
  });

  it('29. token + work_dir + session → recovery', () => {
    expect(decideView({ token: 't', workDir: '/h', session: 's' })).toBe('recovery');
  });

  it('30. token + session (no work_dir) → recovery (degenerate but tolerated)', () => {
    // Schema-tolerated shape; App.tsx's level branch would
    // render recovery. The M4 normal flow never produces this
    // (the ChoicePage enforces the two-level order), but the
    // parser must not panic.
    expect(decideView({ token: 't', workDir: null, session: 's' })).toBe('recovery');
  });

  it('31. token + work_dir + session=new → recovery (pending placeholder)', () => {
    expect(decideView({ token: 't', workDir: '/h', session: 'new' })).toBe('recovery');
  });
});

// ---------------------------------------------------------------------------
// Navigation helpers (钉子 6 actions)
// ---------------------------------------------------------------------------

describe('hash — navigation helpers (钉子 6 actions)', () => {
  it('32. exitSessionHash clears session, keeps work_dir', () => {
    expect(exitSessionHash('tok', '/home/me')).toBe('tok&work_dir=%2Fhome%2Fme');
  });

  it('33. changeWorkDirHash clears work_dir + session', () => {
    expect(changeWorkDirHash('tok')).toBe('tok');
  });

  it('34. newSessionHash writes `&session=new` after work_dir', () => {
    const encoded = newSessionHash('tok', '/home/me');
    expect(encoded).toContain('&session=new');
    expect(encoded).toBe(`tok&work_dir=${encodeURIComponent('/home/me')}&session=new`);
  });

  it('35. selectSessionHash writes all three fields with encoded work_dir', () => {
    const encoded = selectSessionHash('tok', '/Users/foo bar/', 'sess1');
    expect(encoded).toBe(
      `tok&work_dir=${encodeURIComponent('/Users/foo bar/')}&session=sess1`,
    );
    // Round-trip sanity — special-character work_dir survives.
    expect(readAuthFromHash(encoded).workDir).toBe('/Users/foo bar/');
  });

  it('36. selectWorkDirHash writes work_dir only (no session)', () => {
    expect(selectWorkDirHash('tok', '/home/me')).toBe('tok&work_dir=%2Fhome%2Fme');
  });
});

// ---------------------------------------------------------------------------
// Decision-table driven dispatch (hash + decideView combined)
// ---------------------------------------------------------------------------

describe('hash — decision-table end-to-end', () => {
  it('37. M3 legacy link `#tok` → choiceLevel1 (compatibility path)', () => {
    const auth = readAuthFromHash('#tok');
    expect(decideView(auth)).toBe('choiceLevel1');
  });

  it('38. F5 with full hash → recovery directly (skip choice pages)', () => {
    const auth = readAuthFromHash('#tok&work_dir=/h&session=s');
    expect(decideView(auth)).toBe('recovery');
  });

  it('39. selecting work_dir from level=1 produces level=2 hash', () => {
    const fromLevel1 = readAuthFromHash('#tok');
    expect(decideView(fromLevel1)).toBe('choiceLevel1');
    const selectHash = selectWorkDirHash(fromLevel1.token!, '/h');
    const nextAuth = readAuthFromHash(selectHash);
    expect(decideView(nextAuth)).toBe('choiceLevel2');
  });

  it('40. selecting session from level=2 produces recovery hash', () => {
    const fromLevel2 = readAuthFromHash('#tok&work_dir=/h');
    expect(decideView(fromLevel2)).toBe('choiceLevel2');
    const selectHash = selectSessionHash(fromLevel2.token!, fromLevel2.workDir!, 's');
    const nextAuth = readAuthFromHash(selectHash);
    expect(decideView(nextAuth)).toBe('recovery');
  });

  it('41. exiting session from level=2 produces level=2 hash (work_dir retained)', () => {
    const fromLevel2 = readAuthFromHash('#tok&work_dir=/h&session=s');
    expect(decideView(fromLevel2)).toBe('recovery');
    const exitHash = exitSessionHash(fromLevel2.token!, fromLevel2.workDir!);
    const nextAuth = readAuthFromHash(exitHash);
    expect(decideView(nextAuth)).toBe('choiceLevel2');
  });

  it('42. changing work_dir from level=2 produces level=1 hash', () => {
    const fromLevel2 = readAuthFromHash('#tok&work_dir=/h&session=s');
    const changeHash = changeWorkDirHash(fromLevel2.token!);
    const nextAuth = readAuthFromHash(changeHash);
    expect(decideView(nextAuth)).toBe('choiceLevel1');
  });
});