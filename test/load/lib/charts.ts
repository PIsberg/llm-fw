/**
 * Mermaid charts for a GitHub job summary, which renders them natively (#598).
 */

/** One line chart; empty string when there is nothing to draw. */
export function mermaidLine(title: string, yLabel: string, xLabels: readonly string[], values: readonly number[]): string {
  if (!values.length) return ''
  const q = (s: string): string => `"${s.replace(/"/g, "'")}"`
  const v = (n: number): string => String(Math.round(n * 10) / 10)
  return [
    '```mermaid',
    'xychart-beta',
    `  title ${q(title)}`,
    `  x-axis [${xLabels.map(q).join(', ')}]`,
    `  y-axis ${q(yLabel)}`,
    `  line [${values.map(v).join(', ')}]`,
    '```',
    '',
  ].join('\n')
}
