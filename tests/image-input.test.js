import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectImageUrls,
  downloadImages,
  imageMimeType,
  imageUrlsOfSegments,
  withImageMarkers,
  withImages
} from '../lib/image-input.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])

function response (body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers })
}

test('image URLs are collected from both segment shapes, current images first, deduplicated and capped', () => {
  assert.deepEqual(imageUrlsOfSegments([
    { type: 'text', text: 'hi' },
    { type: 'image', url: 'https://a.test/1.png' },
    { type: 'image', data: { url: 'http://a.test/2.png' } },
    { type: 'image', url: 'file:///etc/passwd' },
    { type: 'image', file: 'no-url' }
  ]), ['https://a.test/1.png', 'http://a.test/2.png'])

  const event = { img: ['https://a.test/1.png', 'ftp://a.test/x', 'https://a.test/3.png'] }
  const reply = { imageUrls: ['https://a.test/1.png', 'https://a.test/4.png'] }
  assert.deepEqual(collectImageUrls(event, reply, 3), ['https://a.test/1.png', 'https://a.test/3.png', 'https://a.test/4.png'])
  assert.deepEqual(collectImageUrls(event, reply, 1), ['https://a.test/1.png'])
  assert.deepEqual(collectImageUrls({}, undefined, 3), [])
})

test('image type is sniffed from magic bytes', () => {
  assert.equal(imageMimeType(PNG), 'image/png')
  assert.equal(imageMimeType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9)])), 'image/jpeg')
  assert.equal(imageMimeType(Buffer.from('GIF89a......')), 'image/gif')
  assert.equal(imageMimeType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
  assert.equal(imageMimeType(Buffer.from('<html>hello</html>')), '')
})

test('downloads become data URLs and failures are skipped with their codes', async () => {
  const bodies = {
    'https://a.test/ok': () => response(PNG, { headers: { 'content-type': 'application/octet-stream' } }),
    'https://a.test/html': () => response('<html>not an image</html>'),
    'https://a.test/missing': () => response('', { status: 404 }),
    'https://a.test/declared': () => response(PNG, { headers: { 'content-length': '999999' } }),
    'https://a.test/streamed': () => response(Buffer.alloc(64, 1)),
    'https://a.test/broken': () => { throw new TypeError('fetch failed') }
  }
  const { images, failures } = await downloadImages(Object.keys(bodies), {
    maxBytes: 32,
    timeoutMs: 1000,
    fetchImpl: async url => bodies[url]()
  })
  assert.deepEqual(images, [`data:image/png;base64,${PNG.toString('base64')}`])
  assert.deepEqual(failures, ['UNSUPPORTED_TYPE', 'HTTP_ERROR', 'TOO_LARGE', 'TOO_LARGE', 'NETWORK_ERROR'])
})

test('downloads that exceed the timeout fail as TIMEOUT', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
  const { images, failures } = await downloadImages(['https://a.test/slow'], { maxBytes: 32, timeoutMs: 10, fetchImpl })
  assert.deepEqual(images, [])
  assert.deepEqual(failures, ['TIMEOUT'])
})

test('image markers and content parts', () => {
  assert.equal(withImageMarkers('look', 0), 'look')
  assert.equal(withImageMarkers('look', 2), 'look\n[image][image]')
  assert.equal(withImageMarkers('', 1), '[image]')

  const message = { role: 'user', content: 'text', name: 'u_1' }
  assert.equal(withImages(message, []), message)
  assert.deepEqual(withImages(message, ['data:image/png;base64,AA==']), {
    role: 'user',
    name: 'u_1',
    content: [
      { type: 'text', text: 'text' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    ]
  })
})
