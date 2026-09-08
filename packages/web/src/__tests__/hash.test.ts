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

  // Review 修复轮 S2—token 特殊字符解析补强：
  //  M3 token 设计为 clean alphabet (letters + dash + digits)，
  //  避免编码歧义；但 parser 必须 tolerantly 处理：
  //   - token 含 `&`（手工拼接 / 测试用）；
  //   - token 含 `=`（同上）；
  //   - token `&#` 边界（`&` 起始 body 但无 key=value）。
  it('16b. token containing `&` is parsed at first `&` (M3 已知约束: token 不编码)', () => {
    // M3 token 是 room access key，按惯例不 URL 编码——`&`
    // 意味着 body 起点。parser 取 firstAmp 之前作为 token——
    // 即使 token 字符串后面跟 `&&`（double-amp，空 body pair）
    // 仍能正确分割：`#abc&&work_dir=/h&session=s1` →
    //   token = "abc", body = "&work_dir=/h&session=s1"
    //   body 首 pair 为空（连续 `&&`），被 `if (pair.length === 0) continue;` 跳过；
    //   第二 pair 为 "work_dir=/h&session=s1" 讽刺——含 `&`
    //   在 value 内。这里我们要 pin 的语义是：token 严格按 firstAmp
    //   划分，body 后续 `&` 不影响 token 切割。这反映了
    //   M3 的“token 不编码”契约：M3 链接 `#<token>` 假定 token
    //   无 `&`；手工拼接 token 含 `&` 会以 firstAmp 为界被截断，
    //   但不会拖坏 body 后续解析。
    const parsed = readAuthFromHash('#abc&&work_dir=/h&session=s1');
    expect(parsed.token).toBe('abc');
    expect(parsed.workDir).toBe('/h');
    expect(parsed.session).toBe('s1');
  });

  it('16c. token containing `=` parses (token first; body `=value` is treated as key=“” pair)', () => {
    // `=` 在 token 内部不拆分（按 firstAmp 划分 body）；body
    // 内 `key=value` 仍按 `indexOf('=')` 划分。本用例构造 token
    // 含一个 `=` + body 一个有效 work_dir。
    const parsed = readAuthFromHash('#abc=123&work_dir=/h');
    expect(parsed.token).toBe('abc=123');
    expect(parsed.workDir).toBe('/h');
  });

  it('16d. `&#` boundary: hash body literally starts with `#`-bearing value', () => {
    // work_dir 含 `#`：encodeURIComponent 编码为 `%23`；
    // parser 解码后拿到 `/tmp/weird#name`（正确）；
    // 同时 body `&work_dir=...&...` 仍按 `&` 拆分——`#` 在
    // value 内是字面字符而非 fragment delimiter（fragment 仅
    // 出现在 hash 起始 `#` 之后、第一个 `&` 之前）。
    const path = '/srv/build#1/data';
    const raw = `#tok&work_dir=${encodeURIComponent(path)}&session=s`;
    expect(readAuthFromHash(raw)).toEqual({
      token: 'tok',
      workDir: path,
      session: 's',
    });
  });

  // Review 修复轮 S2—session 含 `+` / `%` / 空格 round-trip:
  //   sessionKey 是 pi session file 的 stem，可含日期分隔符；
  //   实测 pi 0.85.1 stem 形式 `YYYY-MM-DDTHH-MM-SS_<short>`
  //   （见 session-layer.ts probe 产物）。但 forward-compat 上
  //   parser 应 tolerantly 处理 url-encoded 后的特殊字符。
  it('16e. session containing `+` round-trips (encode + decode symmetry)', () => {
    const encoded = encodeHash({ token: 'tok', workDir: '/h', session: 'a+b' });
    expect(readAuthFromHash(encoded)).toEqual({
      token: 'tok',
      workDir: '/h',
      session: 'a+b',
    });
  });

  it('16f. session containing `%` round-trips', () => {
    const encoded = encodeHash({ token: 'tok', workDir: '/h', session: 'a%20b' });
    expect(readAuthFromHash(encoded)).toEqual({
      token: 'tok',
      workDir: '/h',
      session: 'a%20b',
    });
  });

  it('16g. session containing space round-trips (encoded as %20)', () => {
    const encoded = encodeHash({ token: 'tok', workDir: '/h', session: 'sess 1' });
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

  it('27. token only → choiceLevel1 (strict M4 钉子 6 — R1 flipped)', () => {
    // task 08 review 修复轮 R1: 翻转 task 07 实施期的 M3-compat
    // 偏离回严格 M4 钉子 6。`#<token>`（无 work_dir / 无 session）
    // 路由 `choiceLevel1`，与 PRD §4.2 决策表一致。task 10 的 e2e
    // 三场景同步迁移到 M4 流（不再依赖该 M3-compat 偏离）——见
    // docs/tasks/m4/08-web-multi-session-store.md#任务-06-c2-移交义务最小侵入
    // 的 M3_LEGACY 退役评估。
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

  // Review 修复轮 W3——退化 hash 形态告警：
  //   `{token, session≠null, workDir=null}` 是手工拼出 URL 才
  //   出现的退化形态（scraper / bot / stale bookmark）。该形态
  //   仍路由到 recovery（钉子 6 文本明文规定），但进 recovery
  //   前应 console.warn 提示。
  it('31b. W3 — degenerate token+session+null work_dir emits console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = decideView({ token: 't', workDir: null, session: 'stale-sess' });
    expect(view).toBe('recovery');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('session without work_dir');
    expect(message).toContain('stale bookmark');
    warn.mockRestore();
  });

  it('31c. W3 — non-degenerate shapes do NOT emit the warn (avoid noise)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    decideView({ token: 't', workDir: '/h', session: 's' });
    decideView({ token: 't', workDir: null, session: null });
    decideView({ token: 't', workDir: '/h', session: null });
    decideView({ token: null, workDir: null, session: null });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
  // R1 翻转：M3 旧链接（仅 token）严格按 M4 钉子 6 决策表
  // 路由到 `choiceLevel1`。task 07 实施期曾开 M3-compat 偏离
  // （路由 `recovery`）以保留旧链接直通 ChatView 的路径；task
  // 08 修复轮翻回严格表，e2e 三场景同步迁移到 M4 流（不再依赖
  // 旧链接旁路）。
  it('37. M3 legacy link `#tok` → choiceLevel1 (strict 钉子 6 post-R1)', () => {
    const auth = readAuthFromHash('#tok');
    expect(decideView(auth)).toBe('choiceLevel1');
  });

  it('38. F5 with full hash → recovery directly (skip choice pages)', () => {
    const auth = readAuthFromHash('#tok&work_dir=/h&session=s');
    expect(decideView(auth)).toBe('recovery');
  });

  it('39. M4 token + work_dir only → choiceLevel2 (per strict 钉子 6)', () => {
    const fromLevel1 = readAuthFromHash('#tok&work_dir=/h');
    expect(decideView(fromLevel1)).toBe('choiceLevel2');
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

  it('42. changing work_dir from level=2 produces a hash that routes to choiceLevel1', () => {
    // changeWorkDirHash produces `#<token>` (drops work_dir +
    // session). 严格 M4 钉子 6 决策表：仅 token → `choiceLevel1`
    // （用户从 level=2 回到 level=1 重新选 work_dir）。R1 翻转
    // 后该路径不再旁路到 recovery。
    const fromLevel2 = readAuthFromHash('#tok&work_dir=/h&session=s');
    const changeHash = changeWorkDirHash(fromLevel2.token!);
    const nextAuth = readAuthFromHash(changeHash);
    expect(decideView(nextAuth)).toBe('choiceLevel1');
  });
});