import {
  App,
  FuzzySuggestModal,
  MarkdownView,
  MarkdownPostProcessorContext,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  RequestUrlResponse,
  Setting,
  setIcon,
  requestUrl
} from 'obsidian'

const BUNDLED_GITHUB_OAUTH_CLIENT_ID = 'Ov23liMc3jMufRhulvvx'

const PLUGIN_DOCS_URL = 'https://github.com/pagameba/obsidian-github-query#readme'

const BLOCK_FIELD_REFERENCE = `Required
  entity: prs | commits

Common
  mode: merged | created | open     (PRs only; default merged)
  date: YYYY-MM-DD | from-note | (omit = use note filename date; ignored for mode: open)
  author: @me | github-login  (optional for PRs, required for commits)
  repo: owner/name          (required for commits; optional filter for PRs)
  limit: 20                 (page size for API + Load more)

Commits only
  exclude_merge_commits: true | false

Lines must look like key: value. Use # at line start for comments.`

type QueryEntity = 'prs' | 'commits'
type QueryMode = 'merged' | 'created' | 'open'

type BlockParseResult =
  | { ok: true; block: GithubQueryBlock }
  | { ok: false; title: string; hints: string[] }

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

interface QueryTemplateItem {
  label: string
  snippet: string
}

class GithubQueryTemplateModal extends FuzzySuggestModal<QueryTemplateItem> {
  constructor(
    app: App,
    private readonly onPick: (snippet: string) => void
  ) {
    super(app)
    this.setPlaceholder('Search templates (merged PRs, commits, …)')
  }

  getItems(): QueryTemplateItem[] {
    return [
      {
        label: 'Open PRs (no date filter)',
        snippet: 'entity: prs\nmode: open\nauthor: @me'
      },
      {
        label: 'PRs merged on note date',
        snippet: 'entity: prs\nmode: merged\nauthor: @me'
      },
      {
        label: 'PRs merged on a fixed day',
        snippet: 'entity: prs\nmode: merged\ndate: 2026-04-15\nauthor: @me'
      },
      {
        label: 'PRs opened on note date',
        snippet: 'entity: prs\nmode: created\nauthor: @me'
      },
      {
        label: 'PRs merged in one repo',
        snippet: 'entity: prs\nmode: merged\nrepo: your-org/your-repo\nauthor: @me'
      },
      {
        label: 'Commits in repo (note date)',
        snippet:
          'entity: commits\nrepo: your-org/your-repo\nauthor: @me\nexclude_merge_commits: true'
      },
      {
        label: 'Commits in repo (fixed day)',
        snippet:
          'entity: commits\ndate: 2026-04-15\nrepo: your-org/your-repo\nauthor: @me\nexclude_merge_commits: true'
      }
    ]
  }

  getItemText(item: QueryTemplateItem): string {
    return item.label
  }

  onChooseItem(item: QueryTemplateItem, _evt: MouseEvent | KeyboardEvent): void {
    this.onPick(item.snippet)
  }
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

    this.addCommand({
      id: 'insert-github-query-block',
      name: 'Insert GitHub query block',
      callback: () => {
        this.openQueryTemplatePicker()
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

  getOAuthClientId(): string {
    const override = this.settings.githubOauthClientId.trim()
    if (override) {
      return override
    }
    return BUNDLED_GITHUB_OAUTH_CLIENT_ID.trim()
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
    const clientId = this.getOAuthClientId()
    if (!clientId) {
      throw new Error(
        'Missing GitHub OAuth client ID. Set BUNDLED_GITHUB_OAUTH_CLIENT_ID in the plugin source or enter an override in settings.'
      )
    }

    return this.requestDeviceCode(clientId)
  }

  async completeGithubDeviceFlowAuth(deviceCode: DeviceCodeResponse): Promise<void> {
    const clientId = this.getOAuthClientId()
    if (!clientId) {
      throw new Error(
        'Missing GitHub OAuth client ID. Set BUNDLED_GITHUB_OAUTH_CLIENT_ID in the plugin source or enter an override in settings.'
      )
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

  openQueryTemplatePicker(): void {
    const modal = new GithubQueryTemplateModal(this.app, (snippet) => {
      this.insertGithubQueryBlockAtCursor(snippet)
    })
    modal.open()
  }

  insertGithubQueryBlockAtCursor(snippet: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) {
      new Notice('Open a markdown note first.')
      return
    }
    const editor = view.editor
    const cursor = editor.getCursor()
    const body = `\n\`\`\`github-query\n${snippet}\n\`\`\`\n`
    editor.replaceRange(body, cursor)
    new Notice('Inserted github-query block.')
  }

  private renderBlockHelp(el: HTMLElement, title: string, hints: string[]) {
    el.addClass('github-query-block-help')
    el.createEl('p', { cls: 'github-query-block-help-title', text: title })
    const ul = el.createEl('ul', { cls: 'github-query-block-help-hints' })
    for (const hint of hints) {
      ul.createEl('li', { text: hint })
    }
    const docRow = el.createEl('p', { cls: 'github-query-block-help-docs' })
    const link = docRow.createEl('a', { text: 'Examples & full reference on GitHub', href: PLUGIN_DOCS_URL })
    link.setAttr('target', '_blank')
    const cmd = el.createEl('p', { cls: 'github-query-block-help-cmd' })
    cmd.setText('Tip: Command palette → Insert GitHub query block')
  }

  private async renderGithubQueryBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ) {
    const parsedResult = this.parseBlock(source)
    if (!parsedResult.ok) {
      this.renderBlockHelp(el, parsedResult.title, parsedResult.hints)
      return
    }
    const parsed = parsedResult.block

    let resolvedDate: string | undefined
    if (parsed.entity === 'prs' && parsed.mode === 'open') {
      resolvedDate = undefined
    } else {
      const d = this.resolveDate(parsed, ctx.sourcePath)
      if (!d) {
        this.renderBlockHelp(el, 'Could not resolve the date for this block.', [
          'Use date: YYYY-MM-DD for a fixed calendar day.',
          'Use date: from-note or omit date to take YYYY-MM-DD from the note filename.',
          'If the filename has no date, add date: YYYY-MM-DD to the block.'
        ])
        return
      }
      resolvedDate = d
    }

    const authorRaw = parsed.author === '@me' ? this.settings.githubUsername : parsed.author ?? ''
    const author = this.sanitizeGithubLogin(authorRaw) || undefined
    if (parsed.entity === 'commits' && !author) {
      this.renderBlockHelp(el, 'No GitHub author is set for this commits query.', [
        'Add author: your-login or author: @me to the block.',
        'For @me, set GitHub username in plugin settings (OAuth usually fills this).'
      ])
      return
    }

    const listEl = el.createEl('div', { cls: 'github-query-results' })
    listEl.createEl('p', { text: 'Loading GitHub results...' })

    try {
      listEl.empty()
      const headingText =
        parsed.entity === 'prs'
          ? parsed.mode === 'open'
            ? 'Open PRs'
            : `PRs ${parsed.mode ?? 'merged'} on ${resolvedDate!}`
          : `Commits on ${resolvedDate!}`
      listEl.createEl('h4', { text: headingText })
      if (parsed.entity === 'commits' && (parsed.excludeMergeCommits ?? false)) {
        listEl.createEl('p', { text: 'Merge commits excluded.' })
      }

      const ul = listEl.createEl('ul')
      const controlsEl = listEl.createDiv({ cls: 'github-query-block-actions' })
      const refreshBtn = controlsEl.createEl('button', {
        cls: 'github-query-refresh',
        attr: { 'aria-label': 'Refresh this query', title: 'Refresh results' }
      })
      setIcon(refreshBtn, 'refresh-cw')
      const loadMoreButton = controlsEl.createEl('button', {
        cls: 'github-query-load-more',
        text: 'Load more'
      })
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

      const loadPage = async (page: number, options?: { bypassCache?: boolean }) => {
        if (page === 1) {
          ul.empty()
          listEl.querySelector('.github-query-empty-msg')?.remove()
          listEl.querySelector('.github-query-error-msg')?.remove()
        }
        const result =
          parsed.entity === 'prs'
            ? await this.fetchPullRequests(
                {
                  mode: parsed.mode ?? 'merged',
                  date: parsed.mode === 'open' ? undefined : resolvedDate,
                  author,
                  repo: parsed.repo,
                  limit: parsed.limit ?? this.settings.defaultLimit,
                  page
                },
                { bypassCache: options?.bypassCache }
              )
            : await this.fetchCommits(
                {
                  date: resolvedDate as string,
                  author: author as string,
                  repo: parsed.repo,
                  limit: parsed.limit ?? this.settings.defaultLimit,
                  page,
                  excludeMergeCommits: parsed.excludeMergeCommits ?? false
                },
                { bypassCache: options?.bypassCache }
              )

        if (page === 1 && result.items.length === 0) {
          listEl.createEl('p', { cls: 'github-query-empty-msg', text: 'No results found.' })
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

      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true
        try {
          nextPage = 1
          loadMoreButton.hide()
          await loadPage(1, { bypassCache: true })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown error while querying GitHub.'
          listEl.querySelector('.github-query-empty-msg')?.remove()
          ul.empty()
          listEl.createEl('p', { cls: 'github-query-error-msg', text: `GitHub query failed: ${message}` })
          console.error(`GitHub query plugin error: ${message}`, error)
        } finally {
          refreshBtn.disabled = false
        }
      })

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

  private parseBlock(source: string): BlockParseResult {
    const data: Record<string, string> = {}
    for (const rawLine of source.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) {
        continue
      }

      const idx = line.indexOf(':')
      if (idx <= 0) {
        return {
          ok: false,
          title: 'Invalid line in github-query block.',
          hints: [
            'Each non-comment line must look like key: value.',
            `Fix or remove this line: ${line}`
          ]
        }
      }

      const key = line.slice(0, idx).trim().toLowerCase()
      const value = line.slice(idx + 1).trim()
      if (!key) {
        return {
          ok: false,
          title: 'Missing key before ":".',
          hints: ['Use lines like entity: prs or author: @me.', `Problem line: ${line}`]
        }
      }
      data[key] = value
    }

    if (Object.keys(data).length === 0) {
      return {
        ok: false,
        title: 'This github-query block is empty.',
        hints: [
          'Add at least entity: prs or entity: commits.',
          'Use Command palette → Insert GitHub query block for a starter template.'
        ]
      }
    }

    if (!data.entity) {
      return {
        ok: false,
        title: 'Missing required field: entity',
        hints: ['Add a line: entity: prs or entity: commits.']
      }
    }

    if (data.entity !== 'prs' && data.entity !== 'commits') {
      return {
        ok: false,
        title: `Unknown entity: ${data.entity}`,
        hints: ['Use entity: prs or entity: commits.']
      }
    }

    const mode = data.mode as QueryMode | undefined
    if (mode && mode !== 'merged' && mode !== 'created' && mode !== 'open') {
      return {
        ok: false,
        title: `Unknown mode: ${mode}`,
        hints: ['For PRs use mode: merged, mode: created, or mode: open.', 'Commits ignore mode.']
      }
    }

    if (data.date !== undefined) {
      const d = data.date.trim()
      if (d && d !== 'from-note' && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return {
          ok: false,
          title: 'Invalid date value.',
          hints: [
            'Use date: YYYY-MM-DD, date: from-note, or omit date to use the note filename.',
            `Got: ${d}`
          ]
        }
      }
    }

    let limit: number | undefined
    if (data.limit !== undefined && data.limit.trim() !== '') {
      const parsedLimit = Number(data.limit)
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        return {
          ok: false,
          title: 'Invalid limit.',
          hints: ['limit must be a positive number.', `Got: ${data.limit}`]
        }
      }
      limit = Math.floor(parsedLimit)
    }

    if (
      data.exclude_merge_commits !== undefined &&
      data.exclude_merge_commits.trim() !== '' &&
      this.parseBoolean(data.exclude_merge_commits) === undefined
    ) {
      return {
        ok: false,
        title: 'Invalid exclude_merge_commits value.',
        hints: ['Use exclude_merge_commits: true or false.', `Got: ${data.exclude_merge_commits}`]
      }
    }

    const entity = data.entity as QueryEntity
    const repo = data.repo?.trim()
    const author = data.author?.trim()
    if (entity === 'commits' && !repo) {
      return {
        ok: false,
        title: 'Commits queries need a repository.',
        hints: ['Add repo: owner/name (same format as on GitHub).']
      }
    }
    if (entity === 'commits' && !author) {
      return {
        ok: false,
        title: 'Commits queries need an author.',
        hints: ['Add author: your-login or author: @me.']
      }
    }

    return {
      ok: true,
      block: {
        entity,
        mode,
        date: data.date,
        author,
        repo: data.repo,
        limit,
        excludeMergeCommits: this.parseBoolean(data.exclude_merge_commits)
      }
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
      const view = leaf.view
      if (!(view instanceof MarkdownView)) {
        continue
      }
      try {
        view.previewMode.rerender(true)
        view.editor.refresh()
        refreshed += 1
      } catch (error) {
        console.error(`GitHub query refresh failed for a markdown view`, error)
      }
    }
    new Notice(
      refreshed > 0
        ? `Cleared GitHub query cache and refreshed ${refreshed} markdown view(s).`
        : 'No open markdown views to refresh.'
    )
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

  private async fetchPullRequests(
    params: {
      mode: QueryMode
      date?: string
      author?: string
      repo?: string
      limit: number
      page: number
    },
    options?: { bypassCache?: boolean }
  ): Promise<PagedQueryResult> {
    const loader = async (): Promise<PagedQueryResult> => {
      const author = this.sanitizeGithubLogin(params.author ?? '')
      const qualifiers = ['is:pr']
      if (author) {
        qualifiers.push(`author:${author}`)
      }
      if (params.mode === 'open') {
        qualifiers.push('is:open')
      } else if (params.mode === 'merged') {
        if (!params.date) {
          throw new Error('merged mode requires date: YYYY-MM-DD')
        }
        qualifiers.push('is:merged', `merged:${params.date}`)
      } else {
        if (!params.date) {
          throw new Error('created mode requires date: YYYY-MM-DD')
        }
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
    }

    if (options?.bypassCache) {
      return loader()
    }
    const key = this.getCacheKey('prs', params)
    return this.getOrSetCache(key, loader)
  }

  private async fetchCommits(
    params: {
      date: string
      author: string
      repo?: string
      limit: number
      page: number
      excludeMergeCommits: boolean
    },
    options?: { bypassCache?: boolean }
  ): Promise<PagedQueryResult> {
    if (!params.repo) {
      throw new Error('Commits query currently requires repo: owner/name')
    }

    const loader = async (): Promise<PagedQueryResult> => {
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
    }

    if (options?.bypassCache) {
      return loader()
    }
    const key = this.getCacheKey('commits', params)
    return this.getOrSetCache(key, loader)
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
      .setName('GitHub OAuth client ID (optional override)')
      .setDesc(
        BUNDLED_GITHUB_OAUTH_CLIENT_ID.trim()
          ? 'Leave blank to use the bundled OAuth app client ID. Set only to test another OAuth app.'
          : 'OAuth app client ID for GitHub Device Flow. Paste your OAuth App client ID here (or bundle one in the plugin source before building).'
      )
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

    const syntax = containerEl.createEl('details', { cls: 'github-query-syntax-details' })
    syntax.createEl('summary', { text: 'Block syntax & fields' })
    const syntaxInner = syntax.createEl('div', { cls: 'github-query-syntax-inner' })
    syntaxInner.createEl('p', {
      text: 'Use a fenced code block with language github-query. One key: value per line. Comments start with #.'
    })
    syntaxInner.createEl('p', {
      text: 'Command palette: Insert GitHub query block — picks a template and inserts it at the cursor.'
    })
    const pre = syntaxInner.createEl('pre', { cls: 'github-query-syntax-pre' })
    pre.setText(BLOCK_FIELD_REFERENCE)
    const docLink = syntaxInner.createEl('p')
    const a = docLink.createEl('a', { text: 'More examples on GitHub', href: PLUGIN_DOCS_URL })
    a.setAttr('target', '_blank')
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
