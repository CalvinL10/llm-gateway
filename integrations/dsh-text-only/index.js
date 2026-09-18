export const name = 'llm-gateway-text-only'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.restrict({ allow: [] })
}
