/**
 * Voice Assistant Context Provider
 * 
 * Shares model initialization across all scenario screens.
 * Models are initialized once and reused, avoiding re-initialization overhead.
 */
import React, { createContext, useContext, useCallback, useState, useRef, ReactNode } from "react"
import { useLlamaModels, ChatMessage } from "./useLlamaModels"
import { useMeloTTS, type ModelSource } from "./useMeloTTS"
import { useWhisperModels } from "./useWhisperModels"

// Pipeline states
export type PipelineState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error"

interface VoiceAssistantContextType {
  // Underlying hooks (for direct access)
  whisper: ReturnType<typeof useWhisperModels>
  llama: ReturnType<typeof useLlamaModels>
  tts: ReturnType<typeof useMeloTTS>
  
  // Initialization
  isInitialized: boolean
  isInitializing: boolean
  initializeAll: (config?: {
    whisperModel?: string
    llamaModel?: string
    ttsModelSource?: ModelSource
  }) => Promise<boolean>
  
  // Status helpers
  isReady: () => boolean
  isWhisperLoading: boolean
  isLlamaLoading: boolean
  isTTSLoading: boolean
}

const VoiceAssistantContext = createContext<VoiceAssistantContextType | null>(null)

// Default configuration
const DEFAULT_CONFIG = {
  whisperModel: "base",
  llamaModel: "gemma-2b-it",
  ttsModelSource: "bert" as ModelSource,
}

export function VoiceAssistantProvider({ children }: { children: ReactNode }) {
  const whisper = useWhisperModels()
  const llama = useLlamaModels()
  const tts = useMeloTTS()
  
  const [isInitialized, setIsInitialized] = useState(false)
  const [isInitializing, setIsInitializing] = useState(false)
  const initializingRef = useRef(false) // Prevent concurrent initialization
  
  // Check if all models are ready
  const isReady = useCallback(() => {
    return (
      whisper.whisperContext !== null &&
      llama.llamaContext !== null &&
      tts.isReady()
    )
  }, [whisper.whisperContext, llama.llamaContext, tts])
  
  // Initialize all models (only once)
  const initializeAll = useCallback(
    async (config?: {
      whisperModel?: string
      llamaModel?: string
      ttsModelSource?: ModelSource
    }) => {
      // Prevent concurrent initialization
      if (initializingRef.current) {
        console.log("[VoiceAssistantProvider] Already initializing, skipping...")
        return false
      }
      
      // Skip if already initialized and ready
      if (isInitialized && isReady()) {
        console.log("[VoiceAssistantProvider] Already initialized and ready")
        return true
      }
      
      initializingRef.current = true
      setIsInitializing(true)
      
      const mergedConfig = { ...DEFAULT_CONFIG, ...config }
      
      try {
        console.log("[VoiceAssistantProvider] Initializing models...")
        
        // Initialize Whisper (if not already)
        if (!whisper.whisperContext) {
          console.log(`[VoiceAssistantProvider] Initializing Whisper: ${mergedConfig.whisperModel}`)
          await whisper.initializeWhisperModel(mergedConfig.whisperModel)
        }
        
        // Initialize Llama (if not already)
        if (!llama.llamaContext) {
          console.log(`[VoiceAssistantProvider] Initializing Llama: ${mergedConfig.llamaModel}`)
          await llama.initializeLlamaModel(mergedConfig.llamaModel, {})
        }
        
        // Initialize TTS (if not already)
        if (!tts.isReady()) {
          console.log(`[VoiceAssistantProvider] Initializing TTS: ${mergedConfig.ttsModelSource}`)
          await tts.switchModelSource(mergedConfig.ttsModelSource)
          const models = await tts.refreshModelFiles(mergedConfig.ttsModelSource)
          const modelToUse = mergedConfig.ttsModelSource === "bert" ? "melo-bert" : "melo-fp32"
          await tts.initializeModel(modelToUse, mergedConfig.ttsModelSource)
        }
        
        console.log("[VoiceAssistantProvider] All models initialized!")
        setIsInitialized(true)
        return true
      } catch (err) {
        console.error("[VoiceAssistantProvider] Initialization failed:", err)
        return false
      } finally {
        initializingRef.current = false
        setIsInitializing(false)
      }
    },
    [whisper, llama, tts, isInitialized, isReady]
  )
  
  const value: VoiceAssistantContextType = {
    whisper,
    llama,
    tts,
    isInitialized,
    isInitializing,
    initializeAll,
    isReady,
    isWhisperLoading: whisper.isInitializingModel || whisper.isDownloading,
    isLlamaLoading: llama.isInitializingModel || llama.isDownloading,
    isTTSLoading: tts.isInitializingModel || tts.isDownloading,
  }
  
  return (
    <VoiceAssistantContext.Provider value={value}>
      {children}
    </VoiceAssistantContext.Provider>
  )
}

export function useVoiceAssistantContext() {
  const context = useContext(VoiceAssistantContext)
  if (!context) {
    throw new Error("useVoiceAssistantContext must be used within a VoiceAssistantProvider")
  }
  return context
}

