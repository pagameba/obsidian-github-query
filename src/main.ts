import {
  App,
  MarkdownView,
  MarkdownPostProcessorContext,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  RequestUrlResponse,
  Setting,
  requestUrl
} from 'obsidian'

type QueryEntity = 'prs' | 'commits'
type QueryMode = 'merged' | 'created'

interface GithubQueryBlock {
  entity: QueryEntity
  mode?: QueryMode
  date?: string
  author?: string
  repo?: string
  limit?: number
  excludeMergeCommits?: boolean
}

interface GithubQuerySettings {
  githubUsername: string
  githubPatToken: string
  githubOauthClientId: string
  githubOauthToken: string
  noteDatePattern: string
  defaultLimit: number
  cacheTtlMinutes: number
  timezoneOffsetMinutes: number
  accessCheckRepo: string
}

const DEFAULT_SETTINGS: GithubQuerySettings = {
  githubUsername: '',
  githubPatToken: '',
  githubOauthClientId: '',
  githubOauthToken: '',
  noteDatePattern: 'YYYY-MM-DD',
  defaultLimit: 20,
  cacheTtlMinutes: 10,
  timezoneOffsetMinutes: new Date().getTimezoneOffset(),
  accessCheckRepo: ''
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface AccessTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface QueryResultItem {
  title: string
  url: string
  subtitle?: string
}

interface PagedQueryResult {
  items: QueryResultItem[]
  hasMore: boolean
}

export default class GithubQueryPlugin extends Plugin {
  settings!: GithubQuerySettings
  queryCache = new Map<string, { expiresAt: number; value: unknown }>()

  async onload() {
    await this.loadSettings()

    this.registerMarkdownCodeBlockProcessor(
      'github-query',
      async (source, el, ctx) => {
        await this.renderGithubQueryBlock(source, el, ctx)
      }
    )

    this.addCommand({
      id: 'refresh-github-query-blocks',
      name: 'Refresh GitHub query blocks',
      callback: () => {
        this.refreshGithubQueryBlocks()
      }
    })

    this.addSettingTab(new GithubQuerySettingTab(this.app, this))
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  async testGithubAccess(repo?: string): Promise<string> {
    const userResponse = await this.githubApiGet('https://api.github.com/user')
    const user = userResponse.json as { login?: string }
    if (!repo) {
      return `Authenticated as ${user.login ?? 'unknown user'}.`
    }

    const repoResponse = await this.githubApiGet(`https://api.github.com/repos/${repo}`)
    const repoInfo = repoResponse.json as { full_name?: string; private?: boolean }
    const visibility = repoInfo.private ? 'private' : 'public'
    return `Authenticated as ${user.login ?? 'unknown user'} with access to ${repoInfo.full_name ?? repo} (${visibility}).`
  }

  async beginGithubDeviceFlowAuth(): Promise<DeviceCodeResponse> {
    const clientId = this.settings.githubOauthClientId.trim()
    if (!clientId) {
      throw new Error('Set a GitHub OAuth client ID first.')
    }

    return this.requestDeviceCode(clientId)
  }

  async completeGithubDeviceFlowAuth(deviceCode: DeviceCodeResponse): Promise<void> {
    const clientId = this.settings.githubOauthClientId.trim()
    if (!clientId) {
      throw new Error('Set a GitHub OAuth client ID first.')
    }

    const token = await this.pollForDeviceAccessToken(clientId, deviceCode)
    this.settings.githubOauthToken = token

    const user = await this.fetchAuthenticatedUser(token)
    if (user.login) {
      this.settings.githubUsername = user.login
    }

    await this.saveSettings()
  }

  async clearGithubOauthSession(): Promise<void> {
    this.settings.githubOauthToken = ''
    await this.saveSettings()
  }

  private async renderGithubQueryBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ) {
    const parsed = this.parseBlock(source)
    if (!parsed) {
      el.createEl('p', { text: 'Invalid github-query block format.' })
      return
    }

    const resolvedDate = this.resolveDate(parsed, ctx.sourcePath)

    if (!resolvedDate) {
      el.createEl('p', {
        text: 'Unable to resolve date. Use YYYY-MM-DD, or omit date/use date: from-note to use the note date.'
      })
      return
    }

    const authorRaw = parsed.author === '@me' ? this.settings.githubUsername : parsed.author ?? ''
    const author = this.sanitizeGithubLogin(authorRaw)
    if (!author) {
      el.createEl('p', { text: 'Set GitHub username in plugin settings or provide author.' })
      return
    }

    const listEl = el.createEl('div', { cls: 'github-query-results' })
    listEl.createEl('p', { text: 'Loading GitHub results...' })

    try {
      listEl.empty()
      const headingText =
        parsed.entity === 'prs'
          ? `PRs ${parsed.mode ?? 'merged'} on ${resolvedDate}`
          : `Commits on ${resolvedDate}`
      listEl.createEl('h4', { text: headingText })
      if (parsed.entity === 'commits' && (parsed.excludeMergeCommits ?? false)) {
        listEl.createEl('p', { text: 'Merge commits excluded.' })
      }

      const ul = listEl.createEl('ul')
      const controlsEl = listEl.createDiv({ cls: 'github-query-auth-actions' })
      const loadMoreButton = controlsEl.createEl('button', { text: 'Load more' })
      loadMoreButton.hide()
      let nextPage = 1

      const appendItems = (items: QueryResultItem[]) => {
        for (const item of items) {
          const li = ul.createEl('li')
          const link = li.createEl('a', { text: item.title, href: item.url })
          link.setAttr('target', '_blank')
          if (item.subtitle) {
            li.appendText(` (${item.subtitle})`)
          }
        }
      }

      const loadPage = async (page: number) => {
        const result =
          parsed.entity === 'prs'
            ? await this.fetchPullRequests({
                mode: parsed.mode ?? 'merged',
                date: resolvedDate,
                author,
                repo: parsed.repo,
                limit: parsed.limit ?? this.settings.defaultLimit,
                page
              })
            : await this.fetchCommits({
                date: resolvedDate,
                author,
                repo: parsed.repo,
                limit: parsed.limit ?? this.settings.defaultLimit,
                page,
                excludeMergeCommits: parsed.excludeMergeCommits ?? false
              })

        if (page === 1 && result.items.length === 0) {
          ul.empty()
          listEl.createEl('p', { text: 'No results found.' })
          loadMoreButton.hide()
          return
        }

        appendItems(result.items)
        if (result.hasMore) {
          nextPage = page + 1
          loadMoreButton.show()
        } else {
          loadMoreButton.hide()
        }
      }

      loadMoreButton.addEventListener('click', async () => {
        loadMoreButton.disabled = true
        loadMoreButton.textContent = 'Loading...'
        try {
          await loadPage(nextPage)
        } finally {
          loadMoreButton.disabled = false
          loadMoreButton.textContent = 'Load more'
        }
      })

      await loadPage(1)
    } catch (error) {
      listEl.empty()
      const message =
        error instanceof Error ? error.message : 'Unknown error while querying GitHub.'
      listEl.createEl('p', { text: `GitHub query failed: ${message}` })
      console.error(`GitHub query plugin error: ${message}`, error)
    }
  }

  private parseBlock(source: string): GithubQueryBlock | null {
    const data: Record<string, string> = {}
    for (const rawLine of source.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) {
        continue
      }

      const idx = line.indexOf(':')
      if (idx <= 0) {
        return null
      }

      const key = line.slice(0, idx).trim().toLowerCase()
      const value = line.slice(idx + 1).trim()
      data[key] = value
    }

    if (!data.entity) {
      return null
    }

    if (data.entity !== 'prs' && data.entity !== 'commits') {
      return null
    }

    const mode = data.mode as QueryMode | undefined
    if (mode && mode !== 'merged' && mode !== 'created') {
      return null
    }

    return {
      entity: data.entity as QueryEntity,
      mode,
      date: data.date,
      author: data.author,
      repo: data.repo,
      limit: data.limit ? Number(data.limit) : undefined,
      excludeMergeCommits: this.parseBoolean(data.exclude_merge_commits)
    }
  }

  private parseBoolean(value?: string): boolean | undefined {
    if (!value) {
      return undefined
    }
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') {
      return true
    }
    if (normalized === 'false' || normalized === 'no' || normalized === '0') {
      return false
    }
    return undefined
  }

  private resolveDate(block: GithubQueryBlock, sourcePath: string): string | null {
    const explicitDate = (block.date ?? '').trim()
    if (explicitDate && explicitDate !== 'from-note') {
      return /^\d{4}-\d{2}-\d{2}$/.test(explicitDate) ? explicitDate : null
    }
    return this.dateFromNotePath(sourcePath)
  }

  private dateFromNotePath(path: string): string | null {
    const cleanPath = normalizePath(path)
    const filename = cleanPath.split('/').pop() ?? cleanPath
    const withoutExt = filename.replace(/\.md$/i, '')
    const match = withoutExt.match(/\d{4}-\d{2}-\d{2}/)
    return match?.[0] ?? null
  }

  private getAuthHeaders(): Record<string, string> {
    const token = this.settings.githubOauthToken || this.settings.githubPatToken
    if (!token) {
      throw new Error('Missing GitHub auth token. Configure OAuth or PAT in settings.')
    }

    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  }

  private formatGithubApiError(response: RequestUrlResponse): string {
    const prefix = `GitHub API ${response.status}`
    const body = response.json as { message?: string; errors?: unknown }
    if (body?.message) {
      const extra = body.errors ? ` — ${JSON.stringify(body.errors)}` : ''
      return `${prefix}: ${body.message}${extra}`
    }
    const text = response.text?.trim()
    return text ? `${prefix}: ${text}` : prefix
  }

  private async githubApiGet(url: string): Promise<RequestUrlResponse> {
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: this.getAuthHeaders(),
      throw: false
    })
    if (response.status >= 400) {
      throw new Error(this.formatGithubApiError(response))
    }
    return response
  }

  private sanitizeGithubLogin(login: string): string {
    return login.replace(/^@/, '').trim()
  }

  private getUtcRangeForDate(yyyyMmDd: string): { startMs: number; endMs: number; sinceIso: string } {
    const [y, m, d] = yyyyMmDd.split('-').map((n) => Number(n))
    const offsetMs = this.settings.timezoneOffsetMinutes * 60 * 1000
    const localStartUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) + offsetMs
    const localEndUtcMs = localStartUtcMs + 24 * 60 * 60 * 1000
    return {
      startMs: localStartUtcMs,
      endMs: localEndUtcMs,
      sinceIso: new Date(localStartUtcMs).toISOString()
    }
  }

  private getCacheKey(kind: string, params: Record<string, string | number | boolean | undefined>): string {
    return `${kind}:${JSON.stringify(params)}`
  }

  private async getOrSetCache(
    key: string,
    loader: () => Promise<PagedQueryResult>
  ): Promise<PagedQueryResult> {
    const now = Date.now()
    const cached = this.queryCache.get(key)
    if (cached && cached.expiresAt > now) {
      return cached.value as PagedQueryResult
    }
    const value = await loader()
    const ttlMs = Math.max(this.settings.cacheTtlMinutes, 1) * 60 * 1000
    this.queryCache.set(key, { value, expiresAt: now + ttlMs })
    return value
  }

  private refreshGithubQueryBlocks() {
    this.queryCache.clear()
    const leaves = this.app.workspace.getLeavesOfType('markdown')
    let refreshed = 0
    for (const leaf of leaves) {
      const view = leaf.view as MarkdownView & { previewMode?: { rerender?: (force?: boolean) => void } }
      if (typeof view.previewMode?.rerender === 'function') {
        view.previewMode.rerender(true)
        refreshed += 1
      }
    }
    new Notice(refreshed > 0 ? `Refreshed GitHub query blocks in ${refreshed} view(s).` : 'No preview views found to refresh.')
  }

  private async requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
    const response = await requestUrl({
      url: 'https://github.com/login/device/code',
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent('repo read:user')}`
    })

    return response.json as DeviceCodeResponse
  }

  private async pollForDeviceAccessToken(
    clientId: string,
    deviceCode: DeviceCodeResponse
  ): Promise<string> {
    const startedAt = Date.now()
    const timeoutMs = deviceCode.expires_in * 1000
    let intervalMs = Math.max(deviceCode.interval, 5) * 1000

    while (Date.now() - startedAt < timeoutMs) {
      await this.sleep(intervalMs)
      const tokenResponse = await this.requestDeviceAccessToken(clientId, deviceCode.device_code)

      if (tokenResponse.access_token) {
        return tokenResponse.access_token
      }

      if (!tokenResponse.error || tokenResponse.error === 'authorization_pending') {
        continue
      }

      if (tokenResponse.error === 'slow_down') {
        intervalMs += 5000
        continue
      }

      if (tokenResponse.error === 'expired_token') {
        throw new Error('Device code expired before authorization completed.')
      }

      if (tokenResponse.error === 'access_denied') {
        throw new Error('Authorization was denied in GitHub.')
      }

      throw new Error(tokenResponse.error_description || `OAuth error: ${tokenResponse.error}`)
    }

    throw new Error('Timed out waiting for GitHub authorization.')
  }

  private async requestDeviceAccessToken(
    clientId: string,
    deviceCode: string
  ): Promise<AccessTokenResponse> {
    const response = await requestUrl({
      url: 'https://github.com/login/oauth/access_token',
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `client_id=${encodeURIComponent(clientId)}&device_code=${encodeURIComponent(
        deviceCode
      )}&grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:device_code')}`
    })

    return response.json as AccessTokenResponse
  }

  private async fetchAuthenticatedUser(token: string): Promise<{ login?: string }> {
    const response = await requestUrl({
      url: 'https://api.github.com/user',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })

    return response.json as { login?: string }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms)
    })
  }

  private async fetchPullRequests(params: {
    mode: QueryMode
    date: string
    author: string
    repo?: string
    limit: number
    page: number
  }): Promise<PagedQueryResult> {
    const key = this.getCacheKey('prs', params)
    return this.getOrSetCache(key, async () => {
      const author = this.sanitizeGithubLogin(params.author)
      const qualifiers = ['is:pr', `author:${author}`]
      if (params.mode === 'merged') {
        qualifiers.push('is:merged', `merged:${params.date}`)
      } else {
        qualifiers.push(`created:${params.date}`)
      }

      if (params.repo) {
        qualifiers.push(`repo:${params.repo}`)
      }

      const q = encodeURIComponent(qualifiers.join(' '))
      const perPage = Math.min(Math.max(params.limit, 1), 100)
      const response = await this.githubApiGet(
        `https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=${perPage}&page=${params.page}`
      )

      const items = (response.json?.items ?? []) as Array<{
        title: string
        html_url: string
        repository_url?: string
      }>
      const totalCount = Number(response.json?.total_count ?? 0)
      const hasMore = params.page * perPage < totalCount && items.length === perPage

      return {
        items: items.map((item) => ({
          title: item.title,
          url: item.html_url,
          subtitle: item.repository_url?.split('/repos/')[1]
        })),
        hasMore
      }
    })
  }

  private async fetchCommits(params: {
    date: string
    author: string
    repo?: string
    limit: number
    page: number
    excludeMergeCommits: boolean
  }): Promise<PagedQueryResult> {
    if (!params.repo) {
      throw new Error('Commits query currently requires repo: owner/name')
    }

    const key = this.getCacheKey('commits', params)
    return this.getOrSetCache(key, async () => {
      const author = this.sanitizeGithubLogin(params.author)
      const { sinceIso, startMs, endMs } = this.getUtcRangeForDate(params.date)
      const perPage = Math.min(Math.max(params.limit, 1), 100)
      const response = await this.githubApiGet(
        `https://api.github.com/repos/${params.repo}/commits?author=${encodeURIComponent(
          author
        )}&since=${encodeURIComponent(sinceIso)}&per_page=${perPage}&page=${params.page}`
      )

      const commits = (response.json ?? []) as Array<{
        html_url: string
        sha: string
        parents?: Array<{ sha: string }>
        commit: { message: string; author?: { date?: string }; committer?: { date?: string } }
      }>

      const inDay = commits.filter((item) => {
        const iso = item.commit.committer?.date || item.commit.author?.date
        if (!iso) {
          return false
        }
        const t = new Date(iso).getTime()
        return t >= startMs && t < endMs
      })

      const filtered = params.excludeMergeCommits
        ? inDay.filter((item) => {
            const parentCount = item.parents?.length ?? 0
            if (parentCount > 1) {
              return false
            }
            const subject = item.commit.message.split('\n')[0].trim().toLowerCase()
            return !subject.startsWith('merge ')
          })
        : inDay

      return {
        items: filtered.slice(0, params.limit).map((item) => ({
          title: item.commit.message.split('\n')[0],
          url: item.html_url,
          subtitle: item.sha.slice(0, 7)
        })),
        hasMore: commits.length === perPage
      }
    })
  }
}

class GithubQuerySettingTab extends PluginSettingTab {
  plugin: GithubQueryPlugin
  oauthPanelEl: HTMLDivElement | null = null
  pendingDeviceAuth: DeviceCodeResponse | null = null
  isAuthorizing = false

  constructor(app: App, plugin: GithubQueryPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    containerEl.createEl('h2', { text: 'GitHub Query Settings' })

    new Setting(containerEl)
      .setName('GitHub OAuth client ID')
      .setDesc('OAuth app client ID used for GitHub Device Flow sign in.')
      .addText((text) =>
        text
          .setPlaceholder('Iv1.abc123...')
          .setValue(this.plugin.settings.githubOauthClientId)
          .onChange(async (value) => {
            this.plugin.settings.githubOauthClientId = value.trim()
            await this.plugin.saveSettings()
          })
      )

    this.oauthPanelEl = containerEl.createDiv({ cls: 'github-query-oauth-panel' })
    this.renderOauthPanel()

    new Setting(containerEl)
      .setName('GitHub username')
      .setDesc('Used when author is set to @me in code blocks.')
      .addText((text) =>
        text
          .setPlaceholder('octocat')
          .setValue(this.plugin.settings.githubUsername)
          .onChange(async (value) => {
            this.plugin.settings.githubUsername = value.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Fallback personal access token')
      .setDesc('Used only when no OAuth token is available.')
      .addText((text) =>
        text
          .setPlaceholder('ghp_...')
          .setValue(this.plugin.settings.githubPatToken)
          .onChange(async (value) => {
            this.plugin.settings.githubPatToken = value.trim()
            await this.plugin.saveSettings()
            this.renderOauthPanel()
          })
      )

    new Setting(containerEl)
      .setName('Default result limit')
      .setDesc('Max items rendered when limit is omitted in a block.')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.defaultLimit)).onChange(async (value) => {
          const parsed = Number(value)
          if (!Number.isFinite(parsed) || parsed <= 0) {
            new Notice('Default limit must be a positive number.')
            return
          }
          this.plugin.settings.defaultLimit = Math.floor(parsed)
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Cache TTL (minutes)')
      .setDesc('How long query results are cached before fetching again.')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.cacheTtlMinutes)).onChange(async (value) => {
          const parsed = Number(value)
          if (!Number.isFinite(parsed) || parsed <= 0) {
            new Notice('Cache TTL must be a positive number.')
            return
          }
          this.plugin.settings.cacheTtlMinutes = Math.floor(parsed)
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Timezone offset (minutes from UTC)')
      .setDesc('Used for day boundaries when filtering commits. Example: Pacific daylight = 420.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.timezoneOffsetMinutes))
          .onChange(async (value) => {
            const parsed = Number(value)
            if (!Number.isFinite(parsed)) {
              new Notice('Timezone offset must be a number.')
              return
            }
            this.plugin.settings.timezoneOffsetMinutes = Math.trunc(parsed)
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Access check repo')
      .setDesc('Optional org/repo used by the access test button.')
      .addText((text) =>
        text
          .setPlaceholder('your-org/your-repo')
          .setValue(this.plugin.settings.accessCheckRepo)
          .onChange(async (value) => {
            this.plugin.settings.accessCheckRepo = value.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Test GitHub access')
      .setDesc('Verifies authentication and optional repo visibility.')
      .addButton((button) =>
        button.setButtonText('Run access check').onClick(async () => {
          button.setDisabled(true)
          button.setButtonText('Checking...')
          try {
            const message = await this.plugin.testGithubAccess(
              this.plugin.settings.accessCheckRepo || undefined
            )
            new Notice(message, 9000)
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Unexpected GitHub access check error.'
            new Notice(message, 9000)
          } finally {
            button.setDisabled(false)
            button.setButtonText('Run access check')
          }
        })
      )
  }

  private renderOauthPanel() {
    if (!this.oauthPanelEl) {
      return
    }

    this.oauthPanelEl.empty()
    const usingOauth = Boolean(this.plugin.settings.githubOauthToken)
    const usingPat = Boolean(this.plugin.settings.githubPatToken)

    const oauthSetting = new Setting(this.oauthPanelEl)
      .setName('GitHub OAuth')
      .setDesc('Use GitHub Device Flow to sign in without manually pasting a token.')

    if (usingOauth) {
      oauthSetting.addButton((button) =>
        button
          .setButtonText('Sign out')
          .setWarning()
          .onClick(async () => {
            this.pendingDeviceAuth = null
            this.isAuthorizing = false
            await this.plugin.clearGithubOauthSession()
            this.renderOauthPanel()
            new Notice('Cleared GitHub OAuth token.')
          })
      )
    } else {
      oauthSetting.addButton((button) =>
        button.setButtonText('Sign in with GitHub').onClick(async () => {
          if (this.isAuthorizing) {
            return
          }
          button.setDisabled(true)
          button.setButtonText('Starting...')
          try {
            const deviceAuth = await this.plugin.beginGithubDeviceFlowAuth()
            this.pendingDeviceAuth = deviceAuth
            this.isAuthorizing = true
            this.renderOauthPanel()
            window.open(deviceAuth.verification_uri, '_blank')

            await this.plugin.completeGithubDeviceFlowAuth(deviceAuth)
            this.pendingDeviceAuth = null
            this.isAuthorizing = false
            this.renderOauthPanel()
            new Notice('GitHub OAuth connected.')
          } catch (error) {
            this.isAuthorizing = false
            const message =
              error instanceof Error
                ? error.message
                : 'Unexpected error while authorizing with GitHub.'
            new Notice(message, 8000)
            console.error(`OAuth sign-in failed: ${message}`, error)
            this.renderOauthPanel()
          } finally {
            button.setDisabled(false)
            button.setButtonText('Sign in with GitHub')
          }
        })
      )
    }

    let status = 'Not authenticated'
    if (usingOauth) {
      status = 'Authenticated via OAuth'
    } else if (usingPat) {
      status = 'Using fallback PAT'
    } else if (this.isAuthorizing && this.pendingDeviceAuth) {
      status = 'Waiting for GitHub authorization'
    }

    const detailsEl = this.oauthPanelEl.createDiv({ cls: 'github-query-auth-details' })
    detailsEl.createEl('p', { text: `Auth status: ${status}` })

    if (this.pendingDeviceAuth) {
      detailsEl.createEl('p', {
        text: `Enter code: ${this.pendingDeviceAuth.user_code}`
      })

      const actions = detailsEl.createDiv({ cls: 'github-query-auth-actions' })
      const copyBtn = actions.createEl('button', { text: 'Copy code' })
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(this.pendingDeviceAuth?.user_code ?? '')
          new Notice('GitHub device code copied.')
        } catch (error) {
          new Notice('Could not copy code automatically.')
          console.error(`Failed to copy device code`, error)
        }
      })

      const openBtn = actions.createEl('button', { text: 'Open GitHub' })
      openBtn.addEventListener('click', () => {
        if (!this.pendingDeviceAuth) {
          return
        }
        window.open(this.pendingDeviceAuth.verification_uri, '_blank')
      })

      const cancelBtn = actions.createEl('button', { text: 'Cancel' })
      cancelBtn.addEventListener('click', () => {
        this.pendingDeviceAuth = null
        this.isAuthorizing = false
        this.renderOauthPanel()
        new Notice('Device authorization display cleared.')
      })
    }
  }
}
