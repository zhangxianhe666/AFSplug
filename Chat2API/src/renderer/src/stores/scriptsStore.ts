import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ScriptState {
  name: string
  enabled: boolean
  lastRun: number | null
  lastResult: string | null
}

interface ScriptsStoreState {
  scripts: Record<string, ScriptState>
  setEnabled: (id: string, enabled: boolean) => void
  setLastRun: (id: string, timestamp: number, result: string) => void
  toggleEnabled: (id: string) => void
}

export const useScriptsStore = create<ScriptsStoreState>()(
  persist(
    (set, get) => ({
      scripts: {
        refresh_glm_token: {
          name: 'GLM Token Refresh',
          enabled: false,
          lastRun: null,
          lastResult: null,
        },
        prebuild_check: {
          name: 'Pre-build Check',
          enabled: false,
          lastRun: null,
          lastResult: null,
        },
        check_source_artifacts: {
          name: 'Check Source Artifacts',
          enabled: false,
          lastRun: null,
          lastResult: null,
        },
        release: {
          name: 'Release',
          enabled: false,
          lastRun: null,
          lastResult: null,
        },
      },
      setEnabled: (id, enabled) => {
        set(state => ({
          scripts: {
            ...state.scripts,
            [id]: { ...state.scripts[id], enabled },
          },
        }))
      },
      setLastRun: (id, timestamp, result) => {
        set(state => ({
          scripts: {
            ...state.scripts,
            [id]: { ...state.scripts[id], lastRun: timestamp, lastResult: result },
          },
        }))
      },
      toggleEnabled: (id) => {
        set(state => ({
          scripts: {
            ...state.scripts,
            [id]: { ...state.scripts[id], enabled: !state.scripts[id].enabled },
          },
        }))
      },
    }),
    { name: 'chat2api-scripts' }
  )
)
