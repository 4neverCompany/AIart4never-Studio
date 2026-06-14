/**
 * V1.4.5-SHELL-INJECTION: unit tests for the cmd.exe escaping helpers
 * that replaced raw `shell: true` for Windows .cmd/.bat shims.
 */
import { describe, it, expect } from 'vitest'
import {
  escapeCmdArgument,
  buildWindowsShimSpawn,
} from '@/lib/providers/cli-utils'

describe('escapeCmdArgument', () => {
  it('quotes a plain prompt (spaces caret-escaped like cross-spawn — harmless to cmd)', () => {
    expect(escapeCmdArgument('hello world', false)).toBe('^"hello^ world^"')
  })

  it('caret-escapes cmd metacharacters so they cannot break out', () => {
    const out = escapeCmdArgument('a & del C:\\x | b', true)
    // every & and | must be caret-escaped (doubled for .cmd targets)
    expect(out).not.toMatch(/[^^]&/)
    expect(out).not.toMatch(/[^^]\|/)
  })

  it('escapes embedded double quotes', () => {
    const out = escapeCmdArgument('say "hi"', false)
    expect(out).toContain('\\^"hi\\^"')
  })

  it('doubles trailing backslashes so the closing quote survives', () => {
    const out = escapeCmdArgument('C:\\path\\', false)
    expect(out).toContain('C:\\path\\\\')
  })
})

describe('buildWindowsShimSpawn', () => {
  it('passes non-shim binaries through untouched (argv array, no shell)', () => {
    const plan = buildWindowsShimSpawn('higgsfield', ['generate', '--prompt', 'a & b'])
    expect(plan.file).toBe('higgsfield')
    expect(plan.args).toEqual(['generate', '--prompt', 'a & b'])
    expect(plan.windowsVerbatimArguments).toBe(false)
  })

  it('passes .cmd through untouched on POSIX (spawnNeedsShell is win32-only)', () => {
    if (process.platform === 'win32') return
    const plan = buildWindowsShimSpawn('mmx.cmd', ['--prompt', 'x'])
    expect(plan.file).toBe('mmx.cmd')
    expect(plan.windowsVerbatimArguments).toBe(false)
  })

  // The win32 escaping branch, exercised on EVERY platform via the
  // injectable `needsShell` param — spawnNeedsShell() is platform-
  // gated, so without injection the security-critical branch would
  // have zero coverage on the Ubuntu CI runners.
  describe('win32 escaping branch (needsShell injected)', () => {
    it('spawns cmd.exe /d /s /c with a quoted, escaped command line', () => {
      const plan = buildWindowsShimSpawn('mmx.cmd', ['--prompt', 'hello'], true)
      expect(plan.file.toLowerCase()).toContain('cmd')
      expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      expect(plan.args).toHaveLength(4)
      expect(plan.args[3]).toMatch(/^".*"$/)
      expect(plan.windowsVerbatimArguments).toBe(true)
    })

    it('neutralizes cmd metacharacters in a hostile prompt', () => {
      const hostile = 'cute cat" & del /q C:\\* & echo "'
      const plan = buildWindowsShimSpawn('higgsfield.cmd', ['--prompt', hostile], true)
      const line = plan.args[3]!
      // No unescaped & may survive — every one must be caret-escaped.
      expect(line).not.toMatch(/[^^]&/)
      // The embedded quote must not terminate the argument: every
      // literal " inside the payload is backslash-escaped (and the
      // backslash itself caret-escaped for the .cmd double-parse).
      expect(line).toContain('\\^^')
    })

    it('neutralizes pipes and redirects', () => {
      const plan = buildWindowsShimSpawn(
        'mmx.cmd',
        ['--prompt', 'a | curl evil > out < in'],
        true,
      )
      const line = plan.args[3]!
      expect(line).not.toMatch(/[^^]\|/)
      expect(line).not.toMatch(/[^^]>/)
      expect(line).not.toMatch(/[^^]</)
    })

    it('caret-escapes % so %ENVVAR% cannot expand', () => {
      const plan = buildWindowsShimSpawn('mmx.cmd', ['--prompt', '%PATH%'], true)
      const line = plan.args[3]!
      expect(line).not.toMatch(/[^^]%/)
    })

    it('binary path with spaces stays a single token', () => {
      const plan = buildWindowsShimSpawn(
        'C:\\Program Files\\mmx\\mmx.cmd',
        ['--version'],
        true,
      )
      const line = plan.args[3]!
      // The binary is the first escaped token; the space inside it is
      // caret-escaped within its quotes, so cmd treats it as one token.
      expect(line.startsWith('"^"C:\\Program^ Files\\mmx\\mmx.cmd^"')).toBe(true)
    })
  })
})
