/**
 * Image input for vision-capable model backends. Image URLs come from the adapter
 * (Yunzai's `e.img` and quoted image segments), never from user text. Images are
 * downloaded here and sent as data URLs, because adapter URLs may expire, carry
 * access keys or point at a local file server the provider cannot reach.
 */

const SIGNATURES = [
  { mime: 'image/jpeg', test: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: 'image/png', test: bytes => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
  { mime: 'image/gif', test: bytes => bytes.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    mime: 'image/webp',
    test: bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  }
]

export class ImageDownloadError extends Error {
  constructor (message, code) {
    super(message)
    this.name = 'ImageDownloadError'
    this.code = code
  }
}

function httpUrl (value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

/** Image URLs from Yunzai message segments, both flat and `{ type, data }` shaped. */
export function imageUrlsOfSegments (segments) {
  if (!Array.isArray(segments)) return []
  return segments
    .filter(segment => segment?.type === 'image')
    .map(segment => httpUrl(segment.url ?? segment.data?.url))
    .filter(Boolean)
}

/** Current-message images first, then quoted ones, deduplicated and capped. */
export function collectImageUrls (event, reply, maxCount) {
  const current = Array.isArray(event?.img) ? event.img.map(httpUrl) : []
  const quoted = Array.isArray(reply?.imageUrls) ? reply.imageUrls : []
  return [...new Set([...current, ...quoted].filter(Boolean))].slice(0, maxCount)
}

/** Sniffs the image type from magic bytes; the server's content-type is not trusted. */
export function imageMimeType (bytes) {
  if (bytes.length < 12) return ''
  return SIGNATURES.find(signature => signature.test(bytes))?.mime ?? ''
}

async function readLimited (response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new ImageDownloadError('Image is too large', 'TOO_LARGE')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw new ImageDownloadError('Image is too large', 'TOO_LARGE')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size)
}

/** Downloads one image and returns it as a base64 data URL. */
export async function downloadImage (url, { maxBytes, timeoutMs, fetchImpl = fetch }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || !response.body) {
      await response.body?.cancel?.()
      throw new ImageDownloadError(`Image download failed (HTTP ${response.status})`, 'HTTP_ERROR')
    }
    let bytes
    try {
      bytes = await readLimited(response, maxBytes)
    } catch (error) {
      controller.abort()
      throw error
    }
    const mime = imageMimeType(bytes)
    if (!mime) throw new ImageDownloadError('Downloaded file is not a supported image', 'UNSUPPORTED_TYPE')
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch (error) {
    if (error instanceof ImageDownloadError) throw error
    if (controller.signal.aborted) throw new ImageDownloadError('Image download timed out', 'TIMEOUT')
    throw new ImageDownloadError('Image download failed', 'NETWORK_ERROR')
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Downloads images concurrently. Failed images are skipped; `failures` holds their
 * error codes so callers can log them without URLs or image data.
 */
export async function downloadImages (urls, options) {
  const results = await Promise.allSettled(urls.map(url => downloadImage(url, options)))
  const images = []
  const failures = []
  for (const result of results) {
    if (result.status === 'fulfilled') images.push(result.value)
    else failures.push(result.reason?.code ?? 'FAILED')
  }
  return { images, failures }
}

/** Turns a string user message into chat-completions content parts with the images. */
export function withImages (message, images) {
  if (!images.length) return message
  return {
    ...message,
    content: [
      { type: 'text', text: message.content },
      ...images.map(url => ({ type: 'image_url', image_url: { url } }))
    ]
  }
}

/** Appends one `[image]` marker per image, matching how history renders images. */
export function withImageMarkers (text, count) {
  if (!count) return text
  const markers = '[image]'.repeat(count)
  return text ? `${text}\n${markers}` : markers
}
