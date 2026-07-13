import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Terminal,
  Play,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Key,
  Timer,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'

interface ScriptDefinition {
  id: string
  nameKey: string
  descKey: string
  icon: React.ComponentType<{ className?: string }>
  path: string
  category: 'token' | 'build' | 'dev' | 'utility'
  hasSchedule: boolean
  defaultEnabled: boolean
}

const scripts: ScriptDefinition[] = [
  {
    id: 'refresh_glm_token',
    nameKey: 'scripts.refreshGLMToken',
    descKey: 'scripts.refreshGLMTokenDesc',
    icon: RefreshCw,
    path: 'scripts/refresh_glm_token.py',
    category: 'token',
    hasSchedule: true,
    defaultEnabled: false,
  },
  {
    id: 'prebuild_check',
    nameKey: 'scripts.prebuildCheck',
    descKey: 'scripts.prebuildCheckDesc',
    icon: CheckCircle2,
    path: 'scripts/prebuild-check.js',
    category: 'build',
    hasSchedule: false,
    defaultEnabled: false,
  },
  {
    id: 'check_source_artifacts',
    nameKey: 'scripts.checkArtifacts',
    descKey: 'scripts.checkArtifactsDesc',
    icon: Clock,
    path: 'scripts/check-source-artifacts.js',
    category: 'build',
    hasSchedule: false,
    defaultEnabled: false,
  },
  {
    id: 'release',
    nameKey: 'scripts.release',
    descKey: 'scripts.releaseDesc',
    icon: Key,
    path: 'scripts/release.js',
    category: 'build',
    hasSchedule: false,
    defaultEnabled: false,
  },
]

type ExecutionState = Record<string, { running: boolean; lastOutput: string; lastError: string; lastRun: number | null }>

export function Scripts() {
  const { t } = useTranslation()
  const [execState, setExecState] = useState<ExecutionState>({})
  const [scriptToggles, setScriptToggles] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    scripts.forEach(s => { initial[s.id] = s.defaultEnabled })
    return initial
  })
  const [availableScripts, setAvailableScripts] = useState<{ name: string; path: string; description: string }[]>([])

  useEffect(() => {
    // 加载脚本列表
    const loadScripts = async () => {
      try {
        const api = window.electronAPI
        if (api?.scripts?.list) {
          const scripts = await api.scripts.list()
          setAvailableScripts(scripts)
        }
      } catch (error) {
        console.warn('Failed to load scripts list:', error)
      }
    }
    loadScripts()
  }, [])

  const runScript = useCallback(async (scriptId: string, scriptPath: string) => {
    setExecState(prev => ({
      ...prev,
      [scriptId]: { running: true, lastOutput: '', lastError: '', lastRun: null }
    }))

    try {
      const api = window.electronAPI
      // 获取已安装脚本的完整路径
      let resolvedPath = scriptPath
      if (availableScripts.length > 0) {
        const script = availableScripts.find(s => s.name === scriptPath.split('/').pop())
        if (script?.path) resolvedPath = script.path
      }

      const result = api?.scripts
        ? await api.scripts.run(resolvedPath)
        : await api?.invoke('scripts:run', resolvedPath)
          ?? { stdout: '', stderr: 'window.electronAPI 不可用，请在 Electron 环境中运行', exitCode: 1 }
      const output = result.exitCode === 0 ? result.stdout : (result.stderr || result.stdout)
      setExecState(prev => ({
        ...prev,
        [scriptId]: { running: false, lastOutput: output, lastError: result.exitCode !== 0 ? result.stderr : '', lastRun: Date.now() }
      }))
    } catch (error: any) {
      setExecState(prev => ({
        ...prev,
        [scriptId]: { running: false, lastOutput: '', lastError: error?.message || String(error), lastRun: Date.now() }
      }))
    }
  }, [availableScripts])

  const toggleScript = useCallback((scriptId: string, enabled: boolean) => {
    setScriptToggles(prev => ({ ...prev, [scriptId]: enabled }))
    window.electronAPI?.store?.set(`scripts:${scriptId}:enabled`, enabled)
  }, [])

  const categoryGroups = {
    token: { label: t('scripts.categoryToken'), color: 'text-[var(--cyber-green)]' },
    build: { label: t('scripts.categoryBuild'), color: 'text-[var(--cyber-blue)]' },
    dev: { label: t('scripts.categoryDev'), color: 'text-[var(--cyber-purple)]' },
    utility: { label: t('scripts.categoryUtility'), color: 'text-[var(--cyber-yellow)]' },
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t('scripts.title')}</h2>
        <p className="text-muted-foreground">{t('scripts.description')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {scripts.map(script => {
          const state = execState[script.id]
          const isRunning = state?.running ?? false
          const lastOutput = state?.lastOutput ?? ''
          const lastError = state?.lastError ?? ''
          const cat = categoryGroups[script.category]

          return (
            <Card
              key={script.id}
              className={cn(
                'cyber-glass p-5 transition-all duration-300',
                'hover:border-[var(--cyber-blue)] hover:shadow-[0_0_30px_rgba(0,229,255,0.15)]',
                scriptToggles[script.id] && 'border-[var(--cyber-green)]/40'
              )}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    'w-10 h-10 rounded-xl flex items-center justify-center',
                    'bg-[var(--glass-blue)] border border-[var(--cyber-blue)]/30',
                  )}>
                    <script.icon className="h-5 w-5 text-[var(--cyber-blue)]" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-[var(--text-holo)] text-sm">
                      {t(script.nameKey)}
                    </h3>
                    <span className={cn('text-xs', cat.color)}>{cat.label}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={scriptToggles[script.id]}
                    onCheckedChange={(v) => toggleScript(script.id, v)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runScript(script.id, script.path)}
                    disabled={isRunning}
                    className="cyber-btn px-3 py-1.5 text-xs h-8"
                  >
                    {isRunning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    <span className="ml-1.5">{t('scripts.run')}</span>
                  </Button>
                </div>
              </div>

              <p className="text-xs text-[var(--text-dim)] mb-3">{t(script.descKey)}</p>

              {state?.lastRun && (
                <div className="flex items-center gap-1.5 text-xs text-[var(--text-dim)] mb-2">
                  <Timer className="h-3 w-3" />
                  <span>{t('scripts.lastRun')}: {new Date(state.lastRun).toLocaleString()}</span>
                </div>
              )}

              {/* Output area */}
              {(lastOutput || lastError) && (
                <div className={cn(
                  'mt-3 p-3 rounded-lg text-xs font-mono max-h-32 overflow-y-auto',
                  lastError
                    ? 'bg-red-950/30 border border-red-500/20 text-red-300'
                    : 'bg-[var(--bg-circuit-board)] border border-[var(--cyber-blue)]/20 text-[var(--text-terminal)]'
                )}>
                  {lastError ? (
                    <div className="flex items-start gap-2">
                      <XCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-red-400" />
                      <pre className="whitespace-pre-wrap">{lastError}</pre>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <Terminal className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-[var(--cyber-green)]" />
                      <pre className="whitespace-pre-wrap">{lastOutput}</pre>
                    </div>
                  )}
                </div>
              )}
            </Card>
          )
        })}
      </div>

<div className="p-4 rounded-xl bg-[var(--glass-blue)] border border-[var(--cyber-blue)]/20">
        <div className="flex items-start gap-3">
          <Terminal className="h-5 w-5 text-[var(--cyber-blue)] flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-semibold text-[var(--text-holo)]">{t('scripts.pathHint')}</h4>
            <p className="text-xs text-[var(--text-dim)] mt-1">
              {t('scripts.pathHintDesc')}: <code className="text-[var(--cyber-blue)]">{t('scripts.pathExample')}</code>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
