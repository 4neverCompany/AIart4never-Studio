/**
 * V1.7.0-PIPELINE-HIGGSFIELD: shared Higgsfield submit helper.
 */
import { describe, it, expect, vi } from 'vitest'
import { submitHiggsfieldImageShared } from '@/lib/higgsfield/submit-image'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response
}

describe('submitHiggsfieldImageShared', () => {
  it('returns the image on a synchronous completion', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ completed: true, imageUrl: 'https://cdn/hf.jpg', requestId: 'req-1', seed: 7 }),
    ) as unknown as typeof fetch
    const r = await submitHiggsfieldImageShared({ prompt: 'p', apiName: 'nano_banana_2', fetchImpl })
    expect(r).toEqual({ imageUrl: 'https://cdn/hf.jpg', imageId: 'req-1', seed: 7 })
    // posted to the higgsfield image route with the backend slug
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('/api/higgsfield/image')
    expect(JSON.parse((init as RequestInit).body as string).model).toBe('nano_banana_2')
  })

  it('polls the status endpoint on the async path', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ requestId: 'req-async' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'in_progress' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', imageUrl: 'https://cdn/done.jpg', seed: 3 })) as unknown as typeof fetch
    vi.useFakeTimers()
    const p = submitHiggsfieldImageShared({ prompt: 'p', apiName: 'flux_2', fetchImpl })
    await vi.advanceTimersByTimeAsync(5000)
    const r = await p
    vi.useRealTimers()
    expect(r.imageUrl).toBe('https://cdn/done.jpg')
    expect(r.imageId).toBe('req-async')
  })

  it('forwards the CLI token so the route uses the CLI binary path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ completed: true, imageUrl: 'https://cdn/x.jpg' }),
    ) as unknown as typeof fetch
    await submitHiggsfieldImageShared({ prompt: 'p', apiName: 'nano_banana_2', higgsfieldCliToken: 'tok-123', fetchImpl })
    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.higgsfieldCliToken).toBe('tok-123')
  })

  it('throws a descriptive error on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'no credits' }, false, 402),
    ) as unknown as typeof fetch
    await expect(submitHiggsfieldImageShared({ prompt: 'p', apiName: 'nano_banana_2', fetchImpl }))
      .rejects.toThrow('no credits')
  })

  it('throws on a failed/nsfw job', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ requestId: 'r' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'nsfw', error: 'blocked' })) as unknown as typeof fetch
    vi.useFakeTimers()
    const p = submitHiggsfieldImageShared({ prompt: 'p', apiName: 'nano_banana_2', fetchImpl })
    const expectation = expect(p).rejects.toThrow('blocked')
    await vi.advanceTimersByTimeAsync(3000)
    await expectation
    vi.useRealTimers()
  })
})
