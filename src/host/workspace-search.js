import { apply as registerSearch } from './team-runtime/web-search.js'

export const name = 'godbot-web-search'
export const inject = ['web']

// Register the team's search provider in the DSH provider registry.
// The existing web_search tool still enforces its own scope, limits and approvals.
export function apply(ctx, config = {}) {
  const web = ctx.web
  // 0.2.2-rc.1's WebRuntime selects the volatile config id, then the launch
  // environment id. Participate only on explicit selection, so adding NativeCrew
  // never makes a profile with a single implicit provider ambiguous.
  const selected = () => web.config.searchProvider.get() ?? process.env.DSH_WEB_SEARCH_PROVIDER
  try {
    registerSearch({
      get: key => ctx.get(key),
      web: {
        fetch: (request, signal) => web.fetch(request, signal),
        registerSearchProvider(provider) {
          return web.registerSearchProvider({
            ...provider,
            available: () => selected() === provider.id && provider.available(),
          })
        },
      },
    }, config)
  } catch (error) {
    // A separate workspace or another provider plugin may already own "auto".
    if (error?.code !== 'WEB_DUPLICATE_PROVIDER') throw error
  }
}
