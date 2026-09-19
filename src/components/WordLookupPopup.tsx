import React, { useEffect, useState } from 'react'
import { Copy, Volume2, X, Check, Loader2 } from 'lucide-react'
import type { TranslationService } from '../features/translation/service'
import type { TranslationPrefs } from '../features/translation/types'

interface WordLookupPopupProps {
  word: string
  position: { x: number; y: number }
  translationService: TranslationService
  translationPrefs: TranslationPrefs
  onClose: () => void
}

export function WordLookupPopup({
  word,
  position,
  translationService,
  translationPrefs,
  onClose,
}: WordLookupPopupProps) {
  const [translation, setTranslation] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    let active = true
    const abortCtrl = new AbortController()

    setLoading(true)
    setTranslation('')

    // 如果词汇偏短且纯中文，可以翻译成目标语言或英语，如果是外语则翻译为用户设定的 targetLanguage
    const isChinese = /[\u4e00-\u9fa5]/.test(word)
    const targetLang = isChinese
      ? translationPrefs.targetLanguage.startsWith('zh')
        ? 'en'
        : translationPrefs.targetLanguage
      : translationPrefs.targetLanguage

    translationService
      .translateText(
        word,
        {
          sourceLanguage: 'auto',
          targetLanguage: targetLang,
        },
        { signal: abortCtrl.signal },
      )
      .then((res) => {
        if (active) {
          setTranslation(res || '（暂无释义）')
          setLoading(false)
        }
      })
      .catch((err) => {
        if (active) {
          setTranslation(err instanceof Error ? `翻译失败: ${err.message}` : '翻译出错')
          setLoading(false)
        }
      })

    return () => {
      active = false
      abortCtrl.abort()
    }
  }, [word, translationService, translationPrefs])

  const handleCopy = () => {
    if (!translation) return
    navigator.clipboard?.writeText(translation)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleSpeak = () => {
    if (!window.speechSynthesis || speaking) return
    setSpeaking(true)
    const utterance = new SpeechSynthesisUtterance(word)
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(utterance)
  }

  // 视口边界碰撞检测，确保浮层不会超出屏幕
  const screenWidth = typeof window !== 'undefined' ? window.innerWidth : 360
  const screenHeight = typeof window !== 'undefined' ? window.innerHeight : 640
  const popupWidth = Math.min(280, screenWidth - 32)

  let left = position.x - popupWidth / 2
  if (left < 16) left = 16
  if (left + popupWidth > screenWidth - 16) left = screenWidth - 16 - popupWidth

  // 默认显示在点击位置的上方，若上方空间不足则显示在下方
  let top = position.y - 120
  if (top < 60) {
    top = position.y + 24
  }
  if (top + 140 > screenHeight) {
    top = screenHeight - 150
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
        onTouchStart={onClose}
      />
      <div
        className="fixed z-50 rounded-xl border border-haze bg-ink-raised/95 p-3.5 shadow-2xl backdrop-blur-md transition-all animate-in fade-in zoom-in-95 duration-150 text-paper"
        style={{
          top: `${top}px`,
          left: `${left}px`,
          width: `${popupWidth}px`,
        }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-haze/50 pb-2">
          <div className="flex items-center gap-1.5 min-w-0 pr-2">
            <span className="font-serif font-bold text-[15px] truncate text-paper max-w-[170px]">
              {word}
            </span>
            {typeof window !== 'undefined' && 'speechSynthesis' in window && (
              <button
                type="button"
                onClick={handleSpeak}
                aria-label="朗读"
                className={`rounded p-1 text-paper-muted hover:text-paper hover:bg-haze/40 transition-colors ${
                  speaking ? 'text-cinnabar' : ''
                }`}
              >
                <Volume2 size={14} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleCopy}
              aria-label="复制释义"
              className="rounded p-1 text-paper-muted hover:text-paper hover:bg-haze/40 transition-colors"
            >
              {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded p-1 text-paper-muted hover:text-paper hover:bg-haze/40 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="pt-2 text-[13px] leading-relaxed text-paper/90">
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-paper-muted font-mono text-[12px]">
              <Loader2 size={14} className="animate-spin text-cinnabar" />
              <span>正在查询释义…</span>
            </div>
          ) : (
            <p className="max-h-[140px] overflow-y-auto whitespace-pre-wrap select-text font-sans">
              {translation}
            </p>
          )}
        </div>
      </div>
    </>
  )
}
