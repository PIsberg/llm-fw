import { describe, it, expect } from 'vitest'
import { addPortRedirect, removePortRedirect, PF_ANCHOR } from '../../src/cli/portRedirect.js'

// #863: on macOS the :443 redirect was loaded with `pfctl -ef -`, which
// replaces the main ruleset, and removed with `pfctl -F nat`, which flushes
// every NAT rule on the host (Docker Desktop, VPNs, VMs). On Linux each start
// appended the iptables rule again. The redirect now lives in its own pf
// anchor, and iptables is asked before a rule is added.
type Call = { file: string; args: string[]; input?: string }
function recorder(fails: (c: Call) => boolean = () => false) {
  const calls: Call[] = []
  const run = (file: string, args: string[], input?: string): string => {
    const c = { file, args, ...(input !== undefined ? { input } : {}) }
    calls.push(c)
    if (fails(c)) throw new Error('exit 1')
    return ''
  }
  return { calls, run }
}

describe('the :443 redirect on macOS', () => {
  it('is loaded into its own anchor, never the main ruleset', () => {
    const { calls, run } = recorder()
    addPortRedirect('darwin', 8443, run)
    const load = calls.find(c => c.args.includes('-f'))
    expect(load?.args).toEqual(['-a', PF_ANCHOR, '-f', '-'])
    expect(load?.input).toBe('rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port 8443\n')
    expect(PF_ANCHOR.startsWith('com.apple/')).toBe(true)
    for (const c of calls) expect(c.args).not.toContain('-ef')
  })

  it('is removed by flushing that anchor alone', () => {
    const { calls, run } = recorder()
    removePortRedirect('darwin', 8443, run)
    expect(calls).toEqual([{ file: 'pfctl', args: ['-a', PF_ANCHOR, '-F', 'nat'] }])
  })
})

describe('the :443 redirect on Linux', () => {
  const rule = ['-t', 'nat', '%', 'OUTPUT', '-o', 'lo', '-p', 'tcp', '--dport', '443', '-j', 'REDIRECT', '--to-port', '8443']
  const withOp = (op: string) => rule.map(a => (a === '%' ? op : a))

  it('adds the rule only when iptables does not already hold it', () => {
    const missing = recorder(c => c.args.includes('-C'))
    addPortRedirect('linux', 8443, missing.run)
    expect(missing.calls.map(c => c.args)).toEqual([withOp('-C'), withOp('-A')])
    const present = recorder()
    addPortRedirect('linux', 8443, present.run)
    expect(present.calls.map(c => c.args)).toEqual([withOp('-C')])
  })

  it('deletes every copy of the rule, an older version may have added several', () => {
    let copies = 3
    const calls: string[][] = []
    removePortRedirect('linux', 8443, (_file, args) => {
      calls.push(args)
      if (args.includes('-C') && copies === 0) throw new Error('no rule')
      if (args.includes('-D')) copies--
      return ''
    })
    expect(calls.filter(a => a.includes('-D'))).toHaveLength(3)
    expect(copies).toBe(0)
  })
})
