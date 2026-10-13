/**
 * HTML 转义 —— 所有把存储数据渲染进 HTML 的地方（dashboard、FTS 高亮）都必须过这一层。
 * session log 里可能包含任意模型输出 / 工具结果，不转义就是存储型 XSS。
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** 转义 RegExp 元字符（FTS 关键词进正则前必须过这一层） */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
