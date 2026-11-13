/**
 * 品牌标记：文件夹轮廓 + 取景框四角 + 中心点（与安装图标一致）。
 * 用 SVG 而不是位图，14px 下依然清晰，也跟随文字颜色。
 */
export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* 文件夹 */}
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2c.6 0 1.1.3 1.5.8l.9 1.2h7.4A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
      {/* 取景框四角 */}
      <path d="M9 11.6v-1a1 1 0 0 1 1-1h1" />
      <path d="M15 11.6v-1a1 1 0 0 0-1-1h-1" />
      <path d="M9 14.4v1a1 1 0 0 0 1 1h1" />
      <path d="M15 14.4v1a1 1 0 0 1-1 1h-1" />
      {/* 中心点 */}
      <circle cx="12" cy="13" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}
