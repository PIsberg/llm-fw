import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { installSinkholeHosts, restoreSinkholeHosts } from '../../src/cli/hosts.js'

// #852: `llm-fw setup` run a second time (to refresh the CA or the targets)
// backed up the hosts file it had already sinkholed, and `llm-fw stop` then
// restored that backup: every provider stayed mapped to 127.0.0.1 with
// nothing listening on 443, until someone edited the hosts file by hand.
const TARGETS = ['api.anthropic.com', 'api.openai.com']
const ORIGINAL = '127.0.0.1 localhost\n::1 localhost\n10.0.0.5 intranet.example\n'

describe('sinkhole hosts install and restore (#852)', () => {
  let dir: string
  let hostsPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'llm-fw-hosts-'))
    hostsPath = join(dir, 'hosts')
    fs.writeFileSync(hostsPath, ORIGINAL)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('restores the hosts file as it was after one setup', () => {
    installSinkholeHosts(hostsPath, TARGETS)
    expect(fs.readFileSync(hostsPath, 'utf8')).toContain('127.0.0.1 api.openai.com')
    expect(restoreSinkholeHosts(hostsPath, TARGETS)).toBe(true)
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL)
    expect(fs.existsSync(`${hostsPath}.llm-fw.bak`)).toBe(false)
  })

  it('restores the hosts file as it was after setup ran twice', () => {
    installSinkholeHosts(hostsPath, TARGETS)
    installSinkholeHosts(hostsPath, TARGETS)
    restoreSinkholeHosts(hostsPath, TARGETS)
    const restored = fs.readFileSync(hostsPath, 'utf8')
    expect(restored).not.toContain('llm-fw sinkhole')
    expect(restored).not.toContain('api.openai.com')
    expect(restored).toBe(ORIGINAL)
  })

  it('keeps a line the user added between two setups', () => {
    installSinkholeHosts(hostsPath, TARGETS)
    fs.appendFileSync(hostsPath, '10.0.0.6 build.example\n')
    installSinkholeHosts(hostsPath, TARGETS)
    restoreSinkholeHosts(hostsPath, TARGETS)
    const restored = fs.readFileSync(hostsPath, 'utf8')
    expect(restored).toContain('10.0.0.6 build.example')
    expect(restored).not.toContain('llm-fw sinkhole')
  })

  it('heals a backup an older setup wrote with the sinkhole in it', () => {
    // Installs that already ran setup twice hold such a backup.
    const sinkholed = `${ORIGINAL}# llm-fw sinkhole\n127.0.0.1 api.anthropic.com\n127.0.0.1 api.openai.com\n`
    fs.writeFileSync(hostsPath, sinkholed)
    fs.writeFileSync(`${hostsPath}.llm-fw.bak`, sinkholed)
    restoreSinkholeHosts(hostsPath, TARGETS)
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL)
  })

  it('does nothing without a backup', () => {
    expect(restoreSinkholeHosts(hostsPath, TARGETS)).toBe(false)
    expect(fs.readFileSync(hostsPath, 'utf8')).toBe(ORIGINAL)
  })
})
