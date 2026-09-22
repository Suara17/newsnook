import { useState, useMemo } from 'react'
import { Sparkles, Send, Compass, BookmarkCheck, ArrowRight, Loader2 } from 'lucide-react'
import { SettingsShell } from '../../components/SettingsShell'
import { articleRelativeTime } from '../../lib/time'
import { resolveAiFeatureConfig } from '../../features/translation/aiConfig'
import { assertOpenAiConfig } from '../../features/translation/openai'
import type { Article } from '../../lib/types'
import type { NewsCategory } from '../../sources/categories'
import type { Preferences } from '../../sources/preferences'

interface Props {
  articles: Article[]
  categories: NewsCategory[]
  currentCategoryId: string
  favorites: Article[]
  prefs: Preferences
  onOpenArticle: (article: Article) => void
  onBack: () => void
}

interface Recommendation {
  articleId: string
  reason: string
}

// 模块级缓存，保证返回文章后再进入或返回 AI 推荐时，推荐结果依然保留
let cachedRecommendState: {
  selectedCatId: string
  userQuery: string
  recommendations: Recommendation[]
  aiAnalysis: string
} | null = null

export function AiRecommendScreen({
  articles,
  categories,
  currentCategoryId,
  favorites,
  prefs,
  onOpenArticle,
  onBack,
}: Props) {
  const [selectedCatId, setSelectedCatId] = useState<string>(
    () => cachedRecommendState?.selectedCatId || currentCategoryId || 'all',
  )
  const [userQuery, setUserQuery] = useState(() => cachedRecommendState?.userQuery || '')
  const [loading, setLoading] = useState(false)
  const [recommendations, setRecommendations] = useState<Recommendation[]>(
    () => cachedRecommendState?.recommendations || [],
  )
  const [aiAnalysis, setAiAnalysis] = useState(() => cachedRecommendState?.aiAnalysis || '')
  const [errorMessage, setErrorMessage] = useState('')

  // 过滤当前选中分类候选池
  const candidateArticles = useMemo(() => {
    let pool = articles
    if (selectedCatId && selectedCatId !== 'all') {
      const activeCat = categories.find((c) => c.id === selectedCatId)
      if (activeCat && activeCat.sourceIds && activeCat.sourceIds.length > 0) {
        const sourceSet = new Set(activeCat.sourceIds)
        pool = articles.filter((a) => sourceSet.has(a.sourceId))
      }
    }
    // 截取前 45 篇新鲜文章
    return pool.slice(0, 45)
  }, [articles, selectedCatId])

  // 文章映射表
  const articleMap = useMemo(() => {
    return new Map<string, Article>(articles.map((a) => [a.id, a]))
  }, [articles])

  // 调用 AI 推荐
  const handleRequestRecommend = async (customPrompt?: string) => {
    const query = customPrompt !== undefined ? customPrompt : userQuery
    if (loading) return
    setLoading(true)
    setErrorMessage('')
    setRecommendations([])
    setAiAnalysis('')

    try {
      const aiConfig = resolveAiFeatureConfig({ ai: prefs.translation.ai }, 'speedRead')
      const base = assertOpenAiConfig(aiConfig)

      // 组装精简文章池（只取 id, 标题, 摘要, 信源）
      const candidateList = candidateArticles.map((a) => ({
        id: a.id,
        title: a.title,
        summary: a.summary || (a.contentHtml ? a.contentHtml.replace(/<[^>]+>/g, '').slice(0, 100) : ''),
        source: a.sourceLabel,
      }))

      // 提取收藏夹偏好
      const favSample = favorites.slice(0, 5).map((a) => a.title).join('；')

      const systemPrompt = `你是一个专业的新闻阅读助手。请从给定的候选文章列表中，挑选 3~5 篇最匹配用户需求或偏好的文章。
要求：
1. 必须只从给定的候选文章列表 ID 中挑选，严禁编造不存在的 ID。
2. 以 JSON 格式输出推荐结果：
{
  "analysis": "简短的推荐总结或导语（1-2句话）",
  "recommendations": [
    {
      "articleId": "文章ID",
      "reason": "为什么推荐此文章的简短理由（15字以内）"
    }
  ]
}
3. 严格只输出 JSON 字符串，不要带 markdown 代码块标记。`

      const userContent = `用户需求：${query || '根据最近热点与我的偏好推荐'}\n${favSample ? `用户常读/收藏偏好：${favSample}\n` : ''}候选文章列表：\n${JSON.stringify(candidateList)}`

      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: aiConfig.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: 0.6,
        }),
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`AI 请求失败 (${response.status}): ${errText.slice(0, 100)}`)
      }

      const data = await response.json()
      const content = data.choices?.[0]?.message?.content || ''
      const cleaned = content.replace(/```json\n?|\n?```/g, '').trim()
      const parsed = JSON.parse(cleaned)

      const recs = Array.isArray(parsed.recommendations) ? parsed.recommendations : []
      const analysis = parsed.analysis || '为你精选了以下内容：'

      setAiAnalysis(analysis)
      setRecommendations(recs)
      cachedRecommendState = {
        selectedCatId,
        userQuery: query,
        recommendations: recs,
        aiAnalysis: analysis,
      }
    } catch (err: any) {
      console.error('AI Recommend error:', err)
      setErrorMessage(err.message || '推荐生成失败，请检查网络与 API 设置')
    } finally {
      setLoading(false)
    }
  }

  return (
    <SettingsShell
      title="AI 智能荐读"
      caption="根据偏好、分类与需求智能挑选文章"
      onBack={onBack}
    >
      <div className="page-x py-4 space-y-4">
        {/* 分类过滤器 */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
          <button
            type="button"
            onClick={() => setSelectedCatId('all')}
            className={`rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
              selectedCatId === 'all'
                ? 'bg-ink-raised text-paper border border-haze shadow-xs'
                : 'bg-transparent text-paper-muted hover:text-paper hover:bg-ink-raised/40'
            }`}
          >
            全部文章 ({articles.length})
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCatId(cat.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                selectedCatId === cat.id
                  ? 'bg-ink-raised text-paper border border-haze shadow-xs'
                  : 'bg-transparent text-paper-muted hover:text-paper hover:bg-ink-raised/40'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* 快捷推荐预设按钮 */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setUserQuery('挑选今日最值得精读的 3 篇深度文章')
              handleRequestRecommend('挑选今日最值得精读的 3 篇深度文章')
            }}
            className="flex items-center gap-1.5 rounded-lg border border-haze bg-ink-raised/40 px-3 py-1.5 text-xs text-paper-muted hover:text-paper hover:bg-ink-raised/80 transition-colors"
          >
            <Compass size={13} className="text-amber-500" />
            今日深度精选
          </button>
          {favorites.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setUserQuery('根据我收藏夹里的偏好推荐相似文章')
                handleRequestRecommend('根据我收藏夹里的偏好推荐相似文章')
              }}
              className="flex items-center gap-1.5 rounded-lg border border-haze bg-ink-raised/40 px-3 py-1.5 text-xs text-paper-muted hover:text-paper hover:bg-ink-raised/80 transition-colors"
            >
              <BookmarkCheck size={13} className="text-cinnabar" />
              猜你喜欢 (基于收藏)
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setUserQuery('有哪些轻松有趣或前沿突破的新闻？')
              handleRequestRecommend('有哪些轻松有趣或前沿突破的新闻？')
            }}
            className="flex items-center gap-1.5 rounded-lg border border-haze bg-ink-raised/40 px-3 py-1.5 text-xs text-paper-muted hover:text-paper hover:bg-ink-raised/80 transition-colors"
          >
            <Sparkles size={13} className="text-purple-400" />
            轻松有趣 / 前沿突破
          </button>
        </div>

        {/* 输入框 */}
        <div className="relative flex items-center">
          <input
            type="text"
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRequestRecommend()
            }}
            placeholder="告诉我你想看什么，比如：AI算力最新动态、开源项目..."
            className="w-full rounded-xl border border-haze bg-ink-raised/50 px-4 py-2.5 pr-11 text-sm text-paper placeholder:text-paper-faint focus:border-paper-muted focus:outline-none"
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => handleRequestRecommend()}
            className="absolute right-1.5 flex h-8 w-8 items-center justify-center rounded-lg bg-paper-raised/10 text-paper hover:bg-paper-raised/20 disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>

        {/* 错误提示 */}
        {errorMessage && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
            {errorMessage}
          </div>
        )}

        {/* AI 导语 */}
        {aiAnalysis && (
          <div className="rounded-xl border border-haze bg-ink-raised/30 p-3.5 text-xs leading-relaxed text-paper-muted">
            <div className="flex items-center gap-1.5 font-medium text-paper mb-1">
              <Sparkles size={14} className="text-amber-500" />
              <span>AI 推荐分析</span>
            </div>
            {aiAnalysis}
          </div>
        )}

        {/* 推荐卡片列表 */}
        {recommendations.length > 0 && (
          <div className="space-y-2.5 pt-1">
            <div className="text-[11px] font-mono tracking-wider text-paper-faint uppercase">
              精选推荐 ({recommendations.length})
            </div>
            <div className="grid gap-2 sm:grid-cols-1 md:grid-cols-2">
              {recommendations.map((rec, idx) => {
                const article = articleMap.get(rec.articleId)
                if (!article) return null
                return (
                  <div
                    key={rec.articleId || idx}
                    onClick={() => onOpenArticle(article)}
                    className="group relative flex flex-col justify-between rounded-xl border border-haze bg-ink-raised/60 p-4 transition-all hover:border-paper-muted/40 hover:bg-ink-raised cursor-pointer shadow-xs"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-paper-faint">
                          {article.sourceLabel} · {articleRelativeTime(article)}
                        </span>
                        {rec.reason && (
                          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-500">
                            {rec.reason}
                          </span>
                        )}
                      </div>
                      <h4 className="mt-2 font-medium text-sm text-paper group-hover:text-amber-400 transition-colors line-clamp-2 leading-snug">
                        {article.title}
                      </h4>
                      {article.summary && (
                        <p className="mt-1.5 text-xs text-paper-muted line-clamp-2 leading-relaxed">
                          {article.summary}
                        </p>
                      )}
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-1 text-[11px] font-medium text-paper-faint group-hover:text-paper transition-colors">
                      <span>立即阅读</span>
                      <ArrowRight size={13} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 初始空状态引导 */}
        {!loading && recommendations.length === 0 && !errorMessage && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-raised/80 text-amber-500/80">
              <Sparkles size={22} />
            </div>
            <p className="mt-3 font-medium text-sm text-paper">开启 AI 智能荐读</p>
            <p className="mt-1 max-w-xs text-xs text-paper-faint leading-relaxed">
              输入你今天感兴趣的主题，或者直接点击上方的快捷推荐标签，AI 将为你从海量订阅中筛选最合适的内容。
            </p>
          </div>
        )}
      </div>
    </SettingsShell>
  )
}
