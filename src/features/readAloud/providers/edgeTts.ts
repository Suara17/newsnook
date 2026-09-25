/**
 * 微软 Edge 在线高质量神经语音 (Edge TTS) Provider
 *
 * 免 API Key，直接调用微软 Edge 浏览器内置的 ReadAloud WebSocket 接口。
 * 具备超高自然度与真人语气（晓晓、云希、云扬等）。
 */

import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
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
  { id: 'en-US-JennyNeural', name: 'Jenny (自然美语 · 推荐)', lang: 'en-US' },
  { id: 'en-US-GuyNeural', name: 'Guy (稳重男声)', lang: 'en-US' },
  { id: 'en-US-AriaNeural', name: 'Aria (生动女声)', lang: 'en-US' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia (标准英音)', lang: 'en-GB' },
  { id: 'ja-JP-NanamiNeural', name: '七海 (日语女声)', lang: 'ja-JP' },
  { id: 'ja-JP-KeitaNeural', name: '圭太 (日语男声)', lang: 'ja-JP' },
]

const EDGE_TTS_CAPABILITIES: ReadAloudProviderCapabilities = {
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

let edgeSequence = 0

function formatRate(rate: number): string {
  const percent = Math.round((rate - 1.0) * 100)
  return percent >= 0 ? `+${percent}%` : `${percent}%`
}

function formatPitch(pitch: number): string {
  const hz = Math.round((pitch - 1.0) * 50)
  return hz >= 0 ? `+${hz}Hz` : `${hz}Hz`
}

async function computeSecMsGec(): Promise<string> {
  const WIN_EPOCH = 116444736000000000n
  const unixNow = BigInt(Date.now())
  const fileTime = ((unixNow * 10000n + WIN_EPOCH) / 100000000n) * 100000000n
  const strToHash = `${fileTime}${TRUSTED_CLIENT_TOKEN}`

  const encoder = new TextEncoder()
  const data = encoder.encode(strToHash)
  const hashBuf = await crypto.subtle.digest('SHA-256', data)
  const hashArr = Array.from(new Uint8Array(hashBuf))
  return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function escapeSsml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }
  return text.replace(/[&<>"']/g, (m) => map[m] || m)
}

function buildSsml(
  text: string,
  voice: string,
  rate: number,
  pitch: number,
): string {
  const rateStr = formatRate(rate)
  const pitchStr = formatPitch(pitch)
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitchStr}' rate='${rateStr}' volume='+0%'>` +
    `${escapeSsml(text)}` +
    `</prosody>` +
    `</voice>` +
    `</speak>`
  )
}

async function requestEdgeSpeechAudio(
  text: string,
  voice: string,
  rate: number,
  pitch: number,
  signal?: AbortSignal,
): Promise<{ blob: Blob; mimeType: string; nativeBase64?: string }> {
  const secMsGec = await computeSecMsGec()
  const url = `${WSS_URL}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}`

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('朗读已取消', 'AbortError'))
      return
    }

    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    const audioChunks: Uint8Array[] = []
    let hasEnded = false

    const cleanup = () => {
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

    signal?.addEventListener('abort', onAbort, { once: true })

    ws.onopen = () => {
      const timestamp = new Date().toISOString()
      const reqId = crypto.randomUUID().replace(/-/g, '')

      const configMsg =
        `X-Timestamp:${timestamp}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
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

      const ssml = buildSsml(text, voice, rate, pitch)
      const ssmlMsg =
        `X-RequestId:${reqId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${timestamp}Z\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml

      ws.send(ssmlMsg)
    }

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) {
          hasEnded = true
          cleanup()
          const totalLength = audioChunks.reduce((acc, cur) => acc + cur.length, 0)
          const merged = new Uint8Array(totalLength)
          let offset = 0
          for (const chunk of audioChunks) {
            merged.set(chunk, offset)
            offset += chunk.length
          }

          let binary = ''
          const len = merged.byteLength
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(merged[i])
          }
          const nativeBase64 = btoa(binary)

          const blob = new Blob([merged.buffer], { type: 'audio/mp3' })
          resolve({ blob, mimeType: 'audio/mp3', nativeBase64 })
        }
      } else if (event.data instanceof ArrayBuffer) {
        const buffer = event.data
        const view = new DataView(buffer)
        if (buffer.byteLength >= 2) {
          const headerLength = view.getInt16(0)
          if (buffer.byteLength > headerLength + 2) {
            const audioData = new Uint8Array(buffer, headerLength + 2)
            audioChunks.push(audioData)
          }
        }
      }
    }

    ws.onerror = (err) => {
      cleanup()
      reject(new Error(`Edge TTS WebSocket 连接异常: ${JSON.stringify(err)}`))
    }

    ws.onclose = () => {
      if (!hasEnded && audioChunks.length === 0) {
        cleanup()
        reject(new Error('Edge TTS 连接意外关闭，未能收到音频数据'))
      } else if (!hasEnded && audioChunks.length > 0) {
        hasEnded = true
        cleanup()
        const totalLength = audioChunks.reduce((acc, cur) => acc + cur.length, 0)
        const merged = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of audioChunks) {
          merged.set(chunk, offset)
          offset += chunk.length
        }
        let binary = ''
        const len = merged.byteLength
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(merged[i])
        }
        const nativeBase64 = btoa(binary)
        const blob = new Blob([merged.buffer], { type: 'audio/mp3' })
        resolve({ blob, mimeType: 'audio/mp3', nativeBase64 })
      }
    }
  })
}

export class EdgeTtsProvider implements ReadAloudProvider {
  readonly id = 'edge' as const
  readonly label = '微软 Edge 在线语音'
  readonly capabilities = EDGE_TTS_CAPABILITIES

  private activeAudio: HTMLAudioElement | null = null
  private activeObjectUrl: string | null = null
  private aborted = false

  async isAvailable(): Promise<boolean> {
    return typeof WebSocket !== 'undefined'
  }

  async listVoices(): Promise<ReadAloudVoice[]> {
    return EDGE_TTS_VOICES
  }

  async speak(
    segment: ReadAloudSegment,
    events: ReadAloudSpeakEvents,
    options: ReadAloudSpeakOptions,
  ): Promise<ReadAloudHandle> {
    this.aborted = false
    const voiceId = options.voiceId || 'zh-CN-XiaoxiaoNeural'

    const payload = await requestEdgeSpeechAudio(
      segment.text,
      voiceId,
      options.rate,
      options.pitch,
      options.signal,
    )

    if (this.aborted || options.signal?.aborted) {
      throw new DOMException('朗读已取消', 'AbortError')
    }

    // 1. 原生平台：使用 ReadAloudNative.playAudio
    if (Capacitor.isNativePlatform() && isNativeReadAloudAvailable() && payload.nativeBase64) {
      const utteranceId = `newsnook-edge-${Date.now()}-${++edgeSequence}`
      let stopped = false
      let listener: PluginListenerHandle | null = null

      const cleanup = async () => {
        options.signal?.removeEventListener('abort', abort)
        const current = listener
        listener = null
        if (current) await current.remove()
      }

      const abort = () => {
        stopped = true
        void ReadAloudNative.stop()
        void cleanup()
      }

      listener = await ReadAloudNative.addListener(
        'readAloudEvent',
        (event) => {
          if (event.utteranceId !== utteranceId) return
          if (event.type === 'started') events.onStart?.()
          if (event.type === 'ended' && !stopped) {
            events.onEnd?.()
            void cleanup()
          }
          if (event.type === 'error' && !stopped) {
            events.onError?.(
              new Error(event.message || 'Android Edge TTS 音频播放失败'),
            )
            void cleanup()
          }
        },
      )

      options.signal?.addEventListener('abort', abort, { once: true })

      try {
        await ReadAloudNative.playAudio({
          utteranceId,
          base64: payload.nativeBase64,
          mimeType: payload.mimeType,
        })
        if (options.signal?.aborted) {
          stopped = true
          await ReadAloudNative.stop().catch(() => {})
          await cleanup()
          throw new DOMException('朗读已取消', 'AbortError')
        }
      } catch (error) {
        await cleanup()
        throw error
      }

      return {
        pause: () => ReadAloudNative.pause(),
        resume: () => ReadAloudNative.resume(),
        stop: async () => {
          stopped = true
          await ReadAloudNative.stop()
          await cleanup()
        },
        dispose: cleanup,
      }
    }

    // 2. Web 端使用 HTMLAudioElement 播放
    const objectUrl = URL.createObjectURL(payload.blob)
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
  }
}