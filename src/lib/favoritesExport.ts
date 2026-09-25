import { loadCachedBody } from './bodyCache'
import {
  buildArticleMarkdown,
  exportMarkdownFile,
  type MarkdownExportResult,
} from './articleMarkdown'
import type { Article } from './types'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatExportDate(ts: number = Date.now()): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * 将收藏夹所有文章合并转换为一个整理归档 Markdown 文件
 */
export function buildFavoritesMarkdownArchive(favorites: Article[]): string {
  const now = Date.now()
  const header = [
    '# 我的收藏归档',
    '',
    `> 导出时间：${new Date(now).toLocaleString('zh-CN')} · 共 ${favorites.length} 篇收藏`,
    '',
    '---',
    '',
  ].join('\n')

  const articlesMarkdown = favorites.map((article, index) => {
    const cached = loadCachedBody(article.id)
    const html = cached?.html || (article.summary ? `<p>${article.summary}</p>` : '<p>（未缓存正文）</p>')

    const md = buildArticleMarkdown({
      article,
      title: article.title,
      html,
      originUrl: article.originUrl,
      exportedAt: now,
    })

    return `\n\n## [${index + 1}] ${article.title}\n\n${md}`
  }).join('\n\n---\n')

  return `${header}${articlesMarkdown}\n`
}

/**
 * 导出收藏夹 Markdown 文件
 */
export async function exportFavoritesAsMarkdown(
  favorites: Article[],
): Promise<MarkdownExportResult> {
  if (favorites.length === 0) {
    return 'cancelled'
  }

  const content = buildFavoritesMarkdownArchive(favorites)
  const fileName = `newsnook-favorites-${formatExportDate()}.md`
  const title = `我的收藏 (${favorites.length} 篇)`

  return await exportMarkdownFile(content, fileName, title)
}
