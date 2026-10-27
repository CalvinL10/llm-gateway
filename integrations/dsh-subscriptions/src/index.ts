import {CodexChatGptAdapter} from '@subscription-source/host/adapter.ts';
import {loadCodexCatalog} from '@subscription-source/host/codex-catalog.ts';
import {CodexAccountPool, codexAccountQuota} from '@subscription-source/host/codex-account-pool.ts';
import {createPlatformTokenStore} from '@subscription-source/host/platform-token-store.ts';
import {registerPreferenceStore} from '@subscription-source/host/preferences.ts';
import {OAuthService} from '@subscription-source/host/oauth-service.ts';
import {UsageService} from '@subscription-source/host/usage-service.ts';
import {ResponsesClient} from '@subscription-source/host/responses-client.ts';
import {registerRoutes} from '@subscription-source/host/routes.ts';
import {ProxyManager} from '@subscription-source/host/proxy-manager.ts';
import {claimProviderRoute} from '@subscription-source/host/common/provider-route.ts';
import {webServerOrigin} from '@subscription-source/host/common/webserver-compat.ts';
import {createControlledModelFetch, readModelRequestLimits} from '@subscription-source/host/common/model-request-control.ts';
import {AntigravityAdapter} from '@subscription-source/host/antigravity/adapter.ts';
import {FileCredentialStore, FileModelSettingsStore, registerAntigravityPreferenceStore} from '@subscription-source/host/antigravity/token-store.ts';
import {AccountPoolStore} from '@subscription-source/host/antigravity/account-pool.ts';
import {registerAntigravityRoutes} from '@subscription-source/host/antigravity/routes.ts';
import {ClaudeAdapter} from '@subscription-source/host/claude/adapter.ts';
import {FileCredentialStore as ClaudeCredentialStore, FileModelSettingsStore as ClaudeModelSettingsStore, registerClaudePreferenceStore} from '@subscription-source/host/claude/token-store.ts';
import {ClaudeAccountPool} from '@subscription-source/host/claude/account-pool.ts';
import {registerClaudeRoutes} from '@subscription-source/host/claude/routes.ts';
import {protectedRouteContext} from './protected-routes.js';

export const name = 'gateway-subscriptions';
export const inject = ['llm', 'connection', 'attachments'];

export async function apply(ctx) {
  // Compose only the three upstream connections. Native tools, search,
  // presets, model selection policies and other providers retain their owners.
  const preferences = registerPreferenceStore(ctx.get('settings'));
  const routes = protectedRouteContext(ctx);
  await preferences.hydrate();
  const proxy = new ProxyManager({getPreferences:()=>preferences.status(),logger:ctx.logger});
  const fetchFn = proxy.createFetch();
  const limits = readModelRequestLimits();
  const modelFetch = provider => createControlledModelFetch(fetchFn, {provider,limits});
  const store = createPlatformTokenStore();
  const pool = new CodexAccountPool({store});
  const oauth = new OAuthService(store, {fetchFn,logger:ctx.logger,pool});
  const usage = new UsageService(oauth, {fetchFn});
  pool.setQuotaBlockedUntil((account,now)=>usage.blockedUntilFor(account.id,account.credentials,now));
  pool.setQuotaSnapshot(account=>{
    const snapshot=usage.snapshotFor(account.id,account.credentials);
    return snapshot===undefined ? undefined : codexAccountQuota(snapshot);
  });
  const responses = new ResponsesClient(oauth,ctx.attachments,{
    fetchFn:modelFetch('codex-chatgpt'),accountPool:pool,
    ...(ctx.get('webServer') ? {localRawImages:{baseUrl:webServerOrigin(ctx.get('webServer'))}} : {}),
    onGenerationFinished:()=>usage.invalidate(),
    outputVerbosity:()=>preferences.status().outputVerbosity,
    fastMode:()=>preferences.status().fastMode,
    reasoningSummary:()=>preferences.status().reasoningSummary,
  });
  const codex = new CodexChatGptAdapter(responses,preferences, options=>oauth.credentials(undefined,{purpose:'tool'})
    .then(credentials=>loadCodexCatalog(credentials,{fetchFn,signal:options?.signal})).catch(()=>[]));
  const claims = [];
  const disposers = [];
  try {
    claims.push(claimProviderRoute(ctx,{providerId:'codex-chatgpt',label:'Codex',adapter:codex}));
    disposers.push(registerRoutes(routes,oauth,usage,preferences,proxy,undefined,undefined,pool));
    const agStore = new FileCredentialStore();
    const agSettings = new FileModelSettingsStore();
    const agPreferences = registerAntigravityPreferenceStore(ctx.get('settings'),agSettings);
    const agPool = new AccountPoolStore(undefined,undefined,agStore);
    const ag = new AntigravityAdapter(agStore,agSettings,agPreferences,{fetchFn:modelFetch('antigravity'),attachments:ctx.attachments},agPool);
    claims.push(claimProviderRoute(ctx,{providerId:'antigravity',label:'Antigravity',adapter:ag}));
    disposers.push(registerAntigravityRoutes(routes,agStore,agSettings,agPreferences,fetchFn,agPool));
    const clStore = new ClaudeCredentialStore();
    const clSettings = new ClaudeModelSettingsStore();
    const clPreferences = registerClaudePreferenceStore(ctx.get('settings'),clSettings);
    const clPool = new ClaudeAccountPool({store:clStore,preferAccountId:()=>clPreferences.status().selectedAccountId});
    const cl = new ClaudeAdapter(clStore,clSettings,clPreferences,{fetchFn:modelFetch('claude'),attachments:ctx.attachments,accountPool:clPool});
    const claim = claimProviderRoute(ctx,{providerId:'claude-subscription',label:'Claude',adapter:cl});
    claims.push(claim);
    disposers.push(registerClaudeRoutes(routes,clStore,clSettings,clPreferences,{fetchFn,serving:()=>claim.serving(),conflict:()=>claim.conflict(),accountPool:clPool}));
  } catch (error) { dispose(); throw error; }
  function dispose() {
    for (const release of disposers.splice(0).reverse()) release();
    for (const claim of claims.splice(0).reverse()) claim.dispose();
    oauth.dispose(); proxy.dispose();
  }
  ctx.on('dispose',dispose);
}
