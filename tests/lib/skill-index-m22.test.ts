/**
 * V1.7.0-M2.2: automatic skill selection — buildSkillSystemBlock opens
 * with a skill index + a routing instruction so the model applies only
 * the skill(s) that fit the current prompt, instead of forcing every
 * active skill onto every prompt.
 */
import { describe, it, expect } from 'vitest'
import { loadAllSkills, buildSkillSystemBlock } from '@/lib/skill-loader'

describe('buildSkillSystemBlock — M2.2 index + routing', () => {
  it('emits a Skill Index listing each active skill name', async () => {
    const block = await buildSkillSystemBlock(['banana-pro-director'])
    expect(block).toContain('### Skill Index')
    expect(block).toMatch(/1\.\s+banana-pro-director\s+—/)
  })

  it('includes the selective routing instruction (apply only what fits)', async () => {
    const block = await buildSkillSystemBlock(['banana-pro-director'])
    expect(block).toContain('Apply ONLY the skill(s)')
    expect(block).toMatch(/ignored, not forced/)
  })

  it('the index carries each skill description', async () => {
    const all = await loadAllSkills()
    const bpd = all.find((s) => s.name === 'banana-pro-director')!
    const block = await buildSkillSystemBlock(['banana-pro-director'])
    // first ~30 chars of the description should appear in the index line
    expect(block).toContain(bpd.description.slice(0, 30))
  })

  it('still includes the full body after the index (skill stays actionable)', async () => {
    const block = await buildSkillSystemBlock(['banana-pro-director'])
    const idxPos = block.indexOf('### Skill Index')
    const bodyPos = block.indexOf('### Skill 1: banana-pro-director')
    expect(idxPos).toBeGreaterThan(-1)
    expect(bodyPos).toBeGreaterThan(idxPos) // body comes AFTER the index
    expect(block).toContain('SLCT') // body content preserved
  })

  it('back-compat: empty / unknown lists still return empty string', async () => {
    expect(await buildSkillSystemBlock([])).toBe('')
    expect(await buildSkillSystemBlock(['nope'])).toBe('')
  })
})
