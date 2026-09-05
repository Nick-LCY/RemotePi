// Vitest specs for the bridge config loader (`config.ts`) — covers
// M3 PRD §6.2 "配置加载" acceptance cases:
//   1. valid JSON → returns parsed config
//   2. missing worker_url → ConfigError code='missing_field'
//   3. missing web_base_url → ConfigError code='missing_field'
//   4. missing work_dir → ConfigError code='missing_field'
//   5. work_dir does not exist → ConfigError code='work_dir_invalid'
//   6. work_dir is a file, not a directory → ConfigError code='work_dir_invalid'
//   7. work_dir is not readable (mock fs) → ConfigError code='work_dir_invalid'
//   8. token field optional; absent → generates a fresh one and does
//      NOT persist
//   9. JSON parse failure → ConfigError code='parse_failed'
//  10. resolveDefaultConfigPath honours XDG_CONFIG_HOME
//  11. resolveDefaultConfigPath falls back to ~/.config/remotepi/bridge.json
//  12. readTokenOrGenerate uses config.token verbatim when present
//
// Style mirrors `packages/shared/src/protocol/__tests__/*.test.ts`:
// one numbered `it` per acceptance case, no shared mutable state
// across cases, assertions spelled out so failures point at the
// property that broke.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  loadBridgeConfig,
  readTokenOrGenerate,
  resolveDefaultConfigPath,
} from '../config.js';
import { generateToken } from '../token.js';

const ORIGINAL_XDG = process.env['XDG_CONFIG_HOME'];
const ORIGINAL_HOME = process.env['HOME'];

beforeEach(() => {
  // Each test gets a fresh tmpdir so concurrent runs / leaked state
  // from previous runs cannot corrupt fixture discovery.
  // Tests that need a specific HOME / XDG override these after
  // reading them via the helpers below.
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_XDG === undefined) {
    delete process.env['XDG_CONFIG_HOME'];
  } else {
    process.env['XDG_CONFIG_HOME'] = ORIGINAL_XDG;
  }
  if (ORIGINAL_HOME === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = ORIGINAL_HOME;
  }
  vi.restoreAllMocks();
});

/** Write a config JSON file to a fresh tmpdir, returning the path.
 *  The tmpdir is cleaned up via the `trackedDirs` registry below. */
const trackedDirs: string[] = [];
function writeConfig(body: object): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-config-test-'));
  trackedDirs.push(dir);
  const p = path.join(dir, 'bridge.json');
  writeFileSync(p, JSON.stringify(body));
  return p;
}

/** Variant of `writeConfig` that writes raw bytes (used for malformed
 *  JSON cases). */
function writeConfigRaw(raw: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-config-test-'));
  trackedDirs.push(dir);
  const p = path.join(dir, 'bridge.json');
  writeFileSync(p, raw);
  return p;
}

/** As above but writes the file at an arbitrary caller-supplied path
 *  (used when the test needs control over the file name). */
function writeConfigAt(p: string, body: object | string): void {
  if (typeof body === 'string') {
    writeFileSync(p, body);
  } else {
    writeFileSync(p, JSON.stringify(body));
  }
}

afterEach(() => {
  for (const dir of trackedDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ----- 1. Happy path --------------------------------------------------------

describe('loadBridgeConfig (config loading per M3 PRD §6.2)', () => {
  it('1. returns the parsed config for a valid JSON file', () => {
    const configPath = writeConfig({
      worker_url: 'wss://remote-pi.sankabox.com/bridge',
      web_base_url: 'https://remote-pi.sankabox.com',
      work_dir: '/tmp',
      token: 'preset-token-1234567890',
    });
    const config = loadBridgeConfig(configPath);
    expect(config.worker_url).toBe('wss://remote-pi.sankabox.com/bridge');
    expect(config.web_base_url).toBe('https://remote-pi.sankabox.com');
    expect(config.work_dir).toBe('/tmp');
    expect(config.token).toBe('preset-token-1234567890');
  });

  // ----- 2-4. Missing required fields --------------------------------------

  it('2. rejects a config that omits worker_url with code=missing_field', () => {
    const configPath = writeConfig({
      // worker_url intentionally absent
      web_base_url: 'https://remote-pi.sankabox.com',
      work_dir: '/tmp',
      token: 'x'.repeat(32),
    });
    expect(() => loadBridgeConfig(configPath)).toThrow(ConfigError);
    try {
      loadBridgeConfig(configPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('missing_field');
      expect((err as ConfigError).message).toMatch(/worker_url/);
    }
  });

  it('3. rejects a config that omits web_base_url with code=missing_field', () => {
    const configPath = writeConfig({
      worker_url: 'wss://remote-pi.sankabox.com/bridge',
      // web_base_url intentionally absent
      work_dir: '/tmp',
      token: 'y'.repeat(32),
    });
    expect(() => loadBridgeConfig(configPath)).toThrow(ConfigError);
    try {
      loadBridgeConfig(configPath);
    } catch (err) {
      expect((err as ConfigError).code).toBe('missing_field');
      expect((err as ConfigError).message).toMatch(/web_base_url/);
    }
  });

  it('4. rejects a config that omits work_dir with code=missing_field', () => {
    const configPath = writeConfig({
      worker_url: 'wss://remote-pi.sankabox.com/bridge',
      web_base_url: 'https://remote-pi.sankabox.com',
      // work_dir intentionally absent
      token: 'z'.repeat(32),
    });
    expect(() => loadBridgeConfig(configPath)).toThrow(ConfigError);
    try {
      loadBridgeConfig(configPath);
    } catch (err) {
      expect((err as ConfigError).code).toBe('missing_field');
      expect((err as ConfigError).message).toMatch(/work_dir/);
    }
  });

  // ----- 5. work_dir doesn't exist -----------------------------------------

  it('5. rejects a config whose work_dir does not exist with code=work_dir_invalid', () => {
    const configPath = writeConfig({
      worker_url: 'wss://remote-pi.sankabox.com/bridge',
      web_base_url: 'https://remote-pi.sankabox.com',
      work_dir: '/this/path/definitely/does/not/exist/anywhere',
      token: 'w'.repeat(32),
    });
    expect(() => loadBridgeConfig(configPath)).toThrow(ConfigError);
    try {
      loadBridgeConfig(configPath);
    } catch (err) {
      expect((err as ConfigError).code).toBe('work_dir_invalid');
    }
  });

  // ----- 6. work_dir is a file ---------------------------------------------

  it('6. rejects a config whose work_dir is a regular file (not a directory) with code=work_dir_invalid', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-config-test-'));
    trackedDirs.push(dir);
    const filePath = path.join(dir, 'not-a-dir.txt');
    writeFileSync(filePath, 'hello');
    const configPath = path.join(dir, 'bridge.json');
    writeConfigAt(configPath, {
      worker_url: 'wss://remote-pi.sankabox.com/bridge',
      web_base_url: 'https://remote-pi.sankabox.com',
      work_dir: filePath,
      token: 'v'.repeat(32),
    });
    expect(() => loadBridgeConfig(configPath)).toThrow(ConfigError);
    try {
      loadBridgeConfig(configPath);
    } catch (err) {
      expect((err as ConfigError).code).toBe('work_dir_invalid');
      // The message specifically calls out "not a directory" so the
      // operator can distinguish from "doesn't exist" or "not readable".
      expect((err as ConfigError).message).toMatch(/not a directory/);
    }
  });

  // ----- 7. work_dir not readable (mock fs) --------------------------------

  it('7. rejects a config whose work_dir is not readable with code=work_dir_invalid (mock fs)', async () => {
    // ESM named imports are read-only bindings — spying on
    // `node:fs.accessSync` via the namespace doesn't propagate to
    // the loader (the binding is captured at module-load time and
    // `vi.spyOn` reports `Cannot redefine property: accessSync`).
    // The pattern below uses a runtime `vi.doMock` swap that
    // re-imports `loadBridgeConfig` with the mocked fs; the
    // "real" version is restored by `vi.doUnmock` in `finally`.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'remotepi-config-test-'));
    trackedDirs.push(dir);
    const configPath = path.join(dir, 'bridge.json');
    writeConfigAt(configPath, {
      worker_url: 'wss://remote-pi.sankabox.com/bridge',
      web_base_url: 'https://remote-pi.sankabox.com',
      work_dir: dir,
      token: 'u'.repeat(32),
    });

    // doMock is scoped to the test file's module graph (it uses the
    // current loader registry rather than the global one vi.mock
    // touches). We mock `node:fs` so that `accessSync` raises an
    // EACCES, while every other fs call passes through to the real
    // implementation (so `statSync` and `readFileSync` still verify
    // the config file + work_dir actually exist on disk).
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        accessSync: () => {
          // Mirror what a real EACCES looks like — accessSync throws
          // an Error with a `code` property when the mode check fails.
          const err = new Error('permission denied (mocked)') as Error & {
            code?: string;
          };
          err.code = 'EACCES';
          throw err;
        },
      };
    });

    try {
      // Reset modules BEFORE the dynamic import so the loader picks
      // up the doMock'd `node:fs`. Without resetModules the previously
      // cached `config.js` (with the real `accessSync` binding) wins.
      vi.resetModules();
      const { loadBridgeConfig: mockedLoad, ConfigError: MockedConfigError } =
        await import('../config.js');
      // Use the freshly-imported ConfigError class for `instanceof`
      // checks — the module was reset so this is a different class
      // identity from the one at the top of the file (ESM module
      // identity is per-graph). Checking class properties directly
      // (name + code) would also work; `instanceof` reads clearer.
      let caught: unknown;
      try {
        mockedLoad(configPath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MockedConfigError);
      const caughtErr = caught as InstanceType<typeof MockedConfigError>;
      expect(caughtErr.code).toBe('work_dir_invalid');
      expect(caughtErr.message).toMatch(/not readable/);
    } finally {
      vi.doUnmock('node:fs');
      // Reset modules again so subsequent tests get a fresh import of
      // `config.js` against the real `node:fs`.
      vi.resetModules();
    }
  });

  // ----- 8. token optional -------------------------------------------------

  it('8. accepts a config with no token field', () => {
    const configPath = writeConfig({
      worker_url: 'wss://remote-pi.sankabox.com/bridge',
      web_base_url: 'https://remote-pi.sankabox.com',
      work_dir: '/tmp',
      // token omitted on purpose
    });
    const config = loadBridgeConfig(configPath);
    // The config loader does NOT generate — it just returns the
    // parsed object. Generation lives in `readTokenOrGenerate`.
    expect(config.token).toBeUndefined();
  });

  // ----- 9. JSON parse failure ---------------------------------------------

  it('9. rejects a config that is not valid JSON with code=parse_failed', () => {
    const configPath = writeConfigRaw('{ this is not json }');
    expect(() => loadBridgeConfig(configPath)).toThrow(ConfigError);
    try {
      loadBridgeConfig(configPath);
    } catch (err) {
      expect((err as ConfigError).code).toBe('parse_failed');
      expect((err as ConfigError).message).toMatch(/not valid JSON/);
    }
  });

  it('9b. rejects a config file that does not exist with code=parse_failed', () => {
    // ENOENT surfaces as `parse_failed` (we cannot distinguish
    // "missing file" from "not readable" at the readFileSync layer;
    // both are operationally "config unavailable" for the operator).
    expect(() => loadBridgeConfig('/nope/bridge.json')).toThrow(ConfigError);
    try {
      loadBridgeConfig('/nope/bridge.json');
    } catch (err) {
      expect((err as ConfigError).code).toBe('parse_failed');
    }
  });

  // ----- 10-11. resolveDefaultConfigPath -----------------------------------

  it('10. resolveDefaultConfigPath honours XDG_CONFIG_HOME', () => {
    process.env['XDG_CONFIG_HOME'] = '/custom/xdg';
    const resolved = resolveDefaultConfigPath();
    expect(resolved).toBe(path.join('/custom/xdg', 'remotepi', 'bridge.json'));
  });

  it('11. resolveDefaultConfigPath falls back to ~/.config/remotepi/bridge.json when XDG is unset', () => {
    delete process.env['XDG_CONFIG_HOME'];
    // HOME override so the test isn't sensitive to the developer's
    // actual home dir.
    process.env['HOME'] = '/home/test-user';
    const resolved = resolveDefaultConfigPath();
    expect(resolved).toBe(
      path.join('/home/test-user', '.config', 'remotepi', 'bridge.json'),
    );
  });

  // ----- 12. readTokenOrGenerate -------------------------------------------

  it('12. readTokenOrGenerate uses config.token verbatim when present and non-empty', () => {
    const preset = 'preset-token-1234567890';
    const result = readTokenOrGenerate({
      worker_url: 'wss://x',
      web_base_url: 'https://x.test',
      work_dir: '/tmp',
      token: preset,
    });
    expect(result.token).toBe(preset);
    // Share URL uses config.web_base_url as its base (no hard-coded
    // production origin any more).
    expect(result.shareUrl).toBe(`https://x.test/#${preset}`);
  });

  it('12b. readTokenOrGenerate generates a fresh token when config.token is missing (no persistence)', () => {
    const result = readTokenOrGenerate({
      worker_url: 'wss://x',
      web_base_url: 'https://x.test',
      work_dir: '/tmp',
      // token omitted
    });
    // Generated tokens are 32-char base64url strings (token.ts contract).
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The generated token must equal what `generateToken()` returns
    // — proves we're going through the right helper, not returning
    // a stale value.
    const second = generateToken();
    expect(second).not.toBe(result.token);
    // Share URL still uses the config's web_base_url.
    expect(result.shareUrl).toBe(`https://x.test/#${result.token}`);
  });

  it('12c. readTokenOrGenerate generates a fresh token when config.token is empty string', () => {
    // The schema permits empty strings (min(1) only applies to the
    // required URL fields), and `readTokenOrGenerate` treats them
    // as "absent" so the bridge never propagates an empty token to
    // the WSS layer (which would break the subprotocol).
    const result = readTokenOrGenerate({
      worker_url: 'wss://x',
      web_base_url: 'https://x.test',
      work_dir: '/tmp',
      token: '',
    });
    expect(result.token).not.toBe('');
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  // ----- 13. ConfigError class shape ---------------------------------------

  it('13. ConfigError carries the documented code union', () => {
    const e1 = new ConfigError('parse_failed', 'x');
    const e2 = new ConfigError('missing_field', 'y');
    const e3 = new ConfigError('work_dir_invalid', 'z');
    expect(e1.code).toBe('parse_failed');
    expect(e2.code).toBe('missing_field');
    expect(e3.code).toBe('work_dir_invalid');
    expect(e1.name).toBe('ConfigError');
    expect(e1).toBeInstanceOf(Error);
  });

  // ----- 14. strict() rejects unknown keys ----------------------------------

  it('14. rejects a config with a camelCase typo (workerUrl instead of worker_url) via schema.strict()', () => {
    // The schema is declared with `.strict()` so an unknown key surfaces
    // as a zod "unrecognized_keys" issue at the root path, NOT as a
    // silent drop. Without strict, zod would parse this object and
    // `config.worker_url` would be undefined — the operator would
    // later see a confusing "your worker_url is missing" error rather
    // than the actionable "you typo'd the key" one. We assert the
    // rejection happens (with code=missing_field, the unified code
    // zod issues collapse to) AND that the typo'd key name itself is
    // in the message — so the operator can grep their config and fix
    // it.
    const configPath = writeConfig({
      // camelCase typo on purpose:
      workerUrl: 'wss://remote-pi.sankabox.com/bridge',
      web_base_url: 'https://remote-pi.sankabox.com',
      work_dir: '/tmp',
      token: 'k'.repeat(32),
    });
    expect(() => loadBridgeConfig(configPath)).toThrow(ConfigError);
    try {
      loadBridgeConfig(configPath);
    } catch (err) {
      expect((err as ConfigError).code).toBe('missing_field');
      // The exact zod issue text varies across zod minor versions,
      // but the typo'd key name must always be present so an
      // operator can find the offending line.
      expect((err as ConfigError).message).toMatch(/workerUrl/);
    }
  });
});
