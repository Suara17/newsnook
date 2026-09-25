/**
 * 微软 Edge 在线高质量神经语音 (Edge TTS) Provider
 *
 * 免 API Key，直接调用微软 Edge 浏览器内置的 ReadAloud WebSocket 接口。
 * 具备超高自然度与真人语气（晓晓、云希、云扬等）。
 */

import { Capacitor } from '@capacitor/core'
import { isNativeReadAloudAvailable, ReadAloudNative } from '../native'
import type {
  ReadAloudHandle,
  ReadAloudProvider,
  ReadAloudProviderCapabilities,
  ReadAloudSegment,
  ReadAloudSpeakEvents,
  ReadAloudSpeakOptions,
  ReadAloudVoice,
} from '../types'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`
const WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`

export const EDGE_TTS_VOICES: ReadAloudVoice[] = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 (温暖亲切 · 推荐)', lang: 'zh-CN' },
  { id: 'zh-CN-YunxiNeural', name: '云希 (阳光沉稳 · 推荐)', lang: 'zh-CN' },
  { id: 'zh-CN-YunyangNeural', name: '云扬 (专业新闻播音)', lang: 'zh-CN' },
  { id: 'zh-CN-XiaohanNeural', name: '晓涵 (知性温柔)', lang: 'zh-CN' },
  { id: 'zh-CN-XiaomengNeural', name: '晓梦 (生动自然)', lang: 'zh-CN' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 (灵动清亮)', lang: 'zh-CN' },
  { id: 'zh-CN-YunjianNeural', name: '云健 (影视解说音)', lang: 'zh-CN' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏 (少年活力)', lang: 'zh-CN' },
  { id: 'zh-HK-HiuMaanNeural', name: '晓曼 (粤语)', lang: 'zh-HK' },
  { id: 'zh-TW-HsiaoChenNeural', name: '晓臻 (台湾国语)', lang: 'zh-TW' },
  { id: 'en-US-JennyNeural', name: 'Jenny (美语女声)', lang: 'en-US' },
  { id: 'en-US-GuyNeural', name: 'Guy (美语男声)', lang: 'en-US' },
]

export const DEFAULT_EDGE_VOICE_ID = 'zh-CN-XiaoxiaoNeural'

const EDGE_CAPABILITIES: ReadAloudProviderCapabilities = {
  voices: true,
  rate: true,
  pitch: true,
  pauseResume: true,
  rangeProgress: false,
  exactTime: !Capacitor.isNativePlatform(),
  seekByCharacter: false,
  streaming: false,
  offline: false,
}

/**
 * 动态计算微软 Sec-MS-GEC 鉴权 token (SHA-256)
 */
async function generateSecMsGec(): Promise<string> {
  // Windows file time (100ns 从 1601-01-01 开始，11644473600 秒)
  const fileTimeSeconds = Date.now() / 1000 + 11644473600
  let ticks = BigInt(Math.floor(fileTimeSeconds * 10000000))
  ticks -= ticks % BigInt(3000000000) // 向下舍入至 5 分钟周期

  const strToHash = `${ticks.toString()}${TRUSTED_CLIENT_TOKEN}`
  const encoder = new TextEncoder()
  const data = encoder.encode(strToHash)

  // 支持 WebCrypto
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function generateConnectionId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '')
  }
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function escapeXml(str: string): string {
  const amp = '&' + 'amp;'
  const lt = '&' + 'lt;'
  const gt = '&' + 'gt;'
  const quot = '&' + 'quot;'
  const apos = '&' + 'apos;'
  return str
    .replace(/&/g, amp)
    .replace(/</g, lt)
    .replace(/>/g, gt)
    .replace(/"/g, quot)
    .replace(/'/g, apos)
}

function formatRate(rate: number): string {
  const percent = Math.round((rate - 1) * 100)
  return percent >= 0 ? `+${percent}%` : `${percent}%`
}

function formatPitch(pitch: number): string {
  const percent = Math.round((pitch - 1) * 100)
  return percent >= 0 ? `+${percent}Hz` : `${percent}Hz`
}

function buildSsml(text: string, voice: string, rate: number, pitch: number): string {
  const clean = escapeXml(text)
  const r = formatRate(rate)
  const p = formatPitch(pitch)
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>
<voice name='${voice}'><prosody pitch='${p}' rate='${r}'>${clean}</prosody></voice>
</speak>`
}

async function requestEdgeSpeechAudio(
  text: string,
  voice: string,
  rate: number,
  pitch: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const secMsGec = await generateSecMsGec()
  const connectionId = generateConnectionId()
  const url = `${WSS_URL}&ConnectionId=${connectionId}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`

  return new Promise<Blob>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('朗读已取消', 'AbortError'))
      return
    }

    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    const audioBuffers: ArrayBuffer[] = []
    let closed = false

    const cleanup = () => {
      closed = true
      signal?.removeEventListener('abort', onAbort)
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close()
        }
      } catch {
        // ignore
      }
    }

    const onAbort = () => {
      cleanup()
      reject(new DOMException('朗读已取消', 'AbortError'))
    }

    signal?.addEventListener('abort', onAbort)

    ws.onopen = () => {
      if (closed) return
      // 发送 speech.config
      const timestamp = new Date().toISOString()
      const configMsg = `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'false',
                },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        })
      ws.send(configMsg)

      // 发送 ssml
      const requestId = generateConnectionId()
      const ssml = buildSsml(text, voice, rate, pitch)
      const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssml}`
      ws.send(ssmlMsg)
    }

    ws.onmessage = (event) => {
      if (closed) return
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) {
          cleanup()
          if (audioBuffers.length === 0) {
            reject(new Error('未接收到音频数据'))
            return
          }
          const blob = new Blob(audioBuffers, { type: 'audio/mpeg' })
          resolve(blob)
        }
      } else if (event.data instanceof ArrayBuffer) {
        const buffer = event.data
        if (buffer.byteLength >= 2) {
          const view = new DataView(buffer)
          const headerLength = view.getUint16(0)
          if (buffer.byteLength > headerLength + 2) {
            const headerBytes = new Uint8Array(buffer, 2, headerLength)
            const headerStr = new TextDecoder('utf-8').decode(headerBytes)
            if (headerStr.includes('Path:audio')) {
              const audioPayload = buffer.slice(headerLength + 2)
              audioBuffers.push(audioPayload)
            }
          }
        }
      }
    }

    ws.onerror = () => {
      cleanup()
      reject(new Error('Edge TTS 连接异常，请检查网络'))
    }

    ws.onclose = () => {
      if (!closed) {
        cleanup()
        if (audioBuffers.length > 0) {
          resolve(new Blob(audioBuffers, { type: 'audio/mpeg' }))
        } else {
          reject(new Error('Edge TTS 连接已中断'))
        }
      }
    }
  })
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, len)))
  }
  return btoa(binary)
}

export class EdgeTtsProvider implements ReadAloudProvider {
  readonly id = 'edge' as const
  readonly capabilities = EDGE_CAPABILITIES

  private activeAudio: HTMLAudioElement | null = null
  private activeObjectUrl: string | null = null
  private activeNativeId: string | null = null
  private aborted = false

  async isAvailable(): Promise<boolean> {
    return typeof WebSocket !== 'undefined'
  }

  async listVoices(): Promise<ReadAloudVoice[]> {
    return EDGE_TTS_VOICES
  }

  async speak(
    segment: ReadAloudSegment,
    options: ReadAloudSpeakOptions,
    events: ReadAloudSpeakEvents,
  ): Promise<ReadAloudHandle> {
    this.aborted = false
    const voiceId = options.voiceId || DEFAULT_EDGE_VOICE_ID

    // 1. 获取 MP3 Blob
    const blob = await requestEdgeSpeechAudio(
      segment.text,
      voiceId,
      options.rate,
      options.pitch,
      options.signal,
    )

    if (this.aborted || options.signal?.aborted) {
      throw new DOMException('朗读已取消', 'AbortError')
    }

    // 2. 播放逻辑：原生 Native 桥或 Web Audio
    if (Capacitor.isNativePlatform() && isNativeReadAloudAvailable()) {
      const base64 = await blobToBase64(blob)
      const nativeId = `edge_${Date.now()}`
      this.activeNativeId = nativeId

      events.onStart?.()

      await ReadAloudNative.speakAudioBase64({
        id: nativeId,
        base64,
        format: 'mp3',
      })

      return {
        pause: async () => {
          await ReadAloudNative.pauseAudio({ id: nativeId })
        },
        resume: async () => {
          await ReadAloudNative.resumeAudio({ id: nativeId })
        },
        stop: async () => {
          await ReadAloudNative.stopAudio({ id: nativeId })
        },
        dispose: async () => {
          await ReadAloudNative.stopAudio({ id: nativeId })
        },
      }
    }

    // 3. Web 端使用 HTMLAudioElement 播放
    const objectUrl = URL.createObjectURL(blob)
    this.activeObjectUrl = objectUrl
    const audio = new Audio(objectUrl)
    this.activeAudio = audio

    const cleanup = () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      if (this.activeObjectUrl) {
        URL.revokeObjectURL(this.activeObjectUrl)
        this.activeObjectUrl = null
      }
      this.activeAudio = null
    }

    return new Promise<ReadAloudHandle>((resolve, reject) => {
      audio.onplay = () => {
        events.onStart?.()
      }

      audio.ontimeupdate = () => {
        events.onTime?.(Math.round(audio.currentTime * 1000))
      }

      audio.onended = () => {
        cleanup()
        events.onEnd?.()
      }

      audio.onerror = () => {
        cleanup()
        const err = new Error('音频解码播放失败')
        events.onError?.(err)
        reject(err)
      }

      audio.play().then(() => {
        resolve({
          pause: async () => {
            audio.pause()
          },
          resume: async () => {
            await audio.play()
          },
          stop: async () => {
            cleanup()
          },
          dispose: async () => {
            cleanup()
          },
        })
      }).catch((playErr) => {
        cleanup()
        reject(playErr)
      })
    })
  }

  async dispose(): Promise<void> {
    this.aborted = true
    if (this.activeAudio) {
      this.activeAudio.pause()
      this.activeAudio = null
    }
    if (this.activeObjectUrl) {
      URL.revokeObjectURL(this.activeObjectUrl)
      this.activeObjectUrl = null
    }
    if (this.activeNativeId) {
      try {
        await ReadAloudNative.stopAudio({ id: this.activeNativeId })
      } catch {
        // ignore
      }
      this.activeNativeId = null
    }
  }
}
