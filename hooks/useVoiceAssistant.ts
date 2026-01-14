/**
 * Integrated Voice Assistant Hook
 *
 * Low-latency pipeline: Speech → Transcription → LLM → TTS → Audio
 *
 * Key optimizations:
 * 1. Sentence-level TTS processing during LLM streaming
 * 2. Audio queue for gapless playback
 * 3. Parallel TTS synthesis while audio plays
 */
import AudioModule from "expo-audio/build/AudioModule"
import { File } from "expo-file-system"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatMessage, useLlamaModels } from "./useLlamaModels"
import { useMeloTTS, type ModelSource } from "./useMeloTTS"
import { useWhisperModels } from "./useWhisperModels"

// Helper to get formatted timestamp for logs
const getTimestamp = () => {
  const now = new Date()
  return `[${now.toLocaleTimeString("en-US", { hour12: false })}.${now
    .getMilliseconds()
    .toString()
    .padStart(3, "0")}]`
}

// Timestamped log helper
const tLog = (...args: any[]) => console.log(getTimestamp(), ...args)

// Pipeline states
export type PipelineState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error"

// Sentence in the TTS queue
interface TTSQueueItem {
  id: string
  text: string
  status: "pending" | "synthesizing" | "ready" | "playing" | "done"
  audioPath?: string
  audioDuration?: number
}

// Configuration for the assistant
export interface VoiceAssistantConfig {
  systemPrompt?: string
  minSentenceLength?: number
  maxConcurrentSynthesis?: number
  /** TTS length scale (speed): 1.0 = normal, <1.0 = faster, >1.0 = slower */
  ttsSpeed?: number
  /** TTS noise scale (naturalness): 0.6 = natural, higher = more expressive */
  ttsNaturalness?: number
  /** TTS noise scale W (duration variation): 0.8 = default */
  ttsNoiseScaleW?: number
  /** Playback rate for audio (0.5 to 2.0, default 1.0). Applied at native level with zero conversion overhead. */
  playbackRate?: number
  /** TTS model source: 'default' (MeloTTS), 'custom', or 'bert' */
  ttsModelSource?: ModelSource
  /** LLM model ID to use (default: 'gemma-3-270m') */
  llamaModel?: string
  /** Whisper model ID to use (default: 'tiny' for speed, 'base' for accuracy) */
  whisperModel?: string
}

const DEFAULT_CONFIG: VoiceAssistantConfig = {
  systemPrompt:
    "You are a helpful, friendly AI assistant. Keep your responses concise and conversational, suitable for voice interaction. Respond in 2-3 sentences when possible.",
  minSentenceLength: 6, // Reduced for phrase-level chunking
  maxConcurrentSynthesis: 1, // One at a time to reduce CPU competition
  ttsSpeed: 1.0, // lengthScale: 1.0 = normal speed (matches useMeloTTS default)
  ttsNaturalness: 0.6, // noiseScale: 0.6 = natural (matches useMeloTTS default)
  ttsNoiseScaleW: 0.8, // noiseScaleW: 0.8 = default duration variation
  playbackRate: 1.0, // Normal playback speed
  ttsModelSource: "bert", // MeloTTS + BERT (best prosody)
  llamaModel: "gemma-3-270m", // Default LLM model (fast, lightweight)
  whisperModel: "tiny", // Default Whisper model (fast)
}

// Minimum audio buffer (in seconds) before starting playback
const MIN_AUDIO_BUFFER_SECONDS = 0.5

// Phrase boundary punctuation - periods, questions, commas, semicolons, colons (NOT exclamation - too emphatic to break)
const PHRASE_BREAK_PUNCTUATION = /[.?,;:]/

// Pause durations (ms) between chunks based on ending punctuation
const PAUSE_AFTER_SENTENCE = 250 // After . or ?
const PAUSE_AFTER_COMMA = 100 // After , or ; or :
// Conjunctions to split on (NOT 'and' or 'or' - too common and breaks natural flow)
const SPLIT_CONJUNCTIONS =
  /\b(but|so|because|although|however|therefore|meanwhile|furthermore)\b/i
// Minimum words per phrase
const MIN_WORDS_PER_PHRASE = 6

// Dependencies interface for dependency injection
export interface VoiceAssistantDeps {
  whisper?: ReturnType<typeof useWhisperModels>;
  llama?: ReturnType<typeof useLlamaModels>;
  tts?: ReturnType<typeof useMeloTTS>;
}

export function useVoiceAssistant(config: VoiceAssistantConfig = {}, deps: VoiceAssistantDeps = {}) {
  // Memoize mergedConfig to prevent unstable dependency in effects
  const mergedConfig = useMemo(() => ({ ...DEFAULT_CONFIG, ...config }), [
    config.systemPrompt,
    config.minSentenceLength,
    config.maxConcurrentSynthesis,
    config.ttsSpeed,
    config.ttsNaturalness,
    config.ttsNoiseScaleW,
    config.playbackRate,
    config.ttsModelSource,
    config.llamaModel,
    config.whisperModel
  ])

  // Pipeline state
  const [pipelineState, setPipelineState] = useState<PipelineState>("idle")
  const [error, setError] = useState<string | null>(null)

  // Transcription state
  const [currentTranscription, setCurrentTranscription] = useState<string>("")
  const [finalTranscription, setFinalTranscription] = useState<string>("")

  // LLM state
  const [llmResponse, setLlmResponse] = useState<string>("")
  const [conversationHistory, setConversationHistory] = useState<ChatMessage[]>(
    []
  )

  // TTS queue state
  const [ttsQueue, setTtsQueue] = useState<TTSQueueItem[]>([])
  const [currentPlayingId, setCurrentPlayingId] = useState<string | null>(null)

  // Audio players pool
  const audioPlayersRef = useRef<Map<string, any>>(new Map())
  const synthesisAbortRef = useRef<boolean>(false)
  const currentTranscriberRef = useRef<any>(null)

  // Synchronous playback guard - prevents race conditions with async state updates
  const isPlaybackInProgressRef = useRef<boolean>(false)

  // Ref-based playback queue for sequential processing (avoids useEffect race conditions)
  const playbackQueueRef = useRef<TTSQueueItem[]>([])
  const isPlaybackChainRunningRef = useRef<boolean>(false)

  // Accumulated text for sentence detection
  const accumulatedTextRef = useRef<string>("")
  const processedSentencesRef = useRef<Set<string>>(new Set())
  const queueIdCounterRef = useRef<number>(0)

  // Hooks - use injected dependencies or create new instances
  const defaultWhisper = useWhisperModels()
  const defaultLlama = useLlamaModels()
  const defaultTts = useMeloTTS()
  
  const whisper = deps.whisper || defaultWhisper
  const llama = deps.llama || defaultLlama
  const tts = deps.tts || defaultTts

  // Destructure stable members from hooks to prevent infinite loops
  // The hooks return new objects on every render, so we must destructure 
  // the specific stable functions/values we need for dependency arrays
  const { whisperContext, initializeWhisperModel, isInitializingModel: isWhisperInitializing } = whisper;
  const { llamaContext, initializeLlamaModel, releaseContext, completion, isInitializingModel: isLlamaInitializing } = llama;
  const { 
    isReady: ttsIsReady, 
    getCurrentModel: ttsGetCurrentModel, 
    getModelDirectory: ttsGetModelDirectory, 
    synthesizeToFile: ttsSynthesizeToFile, 
    switchModelSource: ttsSwitchModelSource, 
    initializeModel: ttsInitializeModel, 
    currentModelSource: ttsCurrentModelSource,
    isInitializingModel: isTtsInitializing,
    stopAudio: ttsStopAudio
  } = tts;

  // Check if all models are ready
  const isReady = useCallback(() => {
    return (
      whisperContext !== null &&
      llamaContext !== null &&
      ttsIsReady()
    )
  }, [whisperContext, llamaContext, ttsIsReady])

  // Get initialization status
  const getInitStatus = useCallback(() => {
    // We can't access getCurrentModel safely in dep array as it might be unstable
    // but these getters are just for UI display
    return {
      whisper: whisperContext !== null,
      llama: llamaContext !== null,
      tts: ttsIsReady(),
      whisperModel: whisper.getCurrentModel()?.label || "Not loaded",
      llamaModel: llama.getCurrentModel()?.label || "Not loaded",
      ttsModel: tts.getCurrentModel()?.label || "Not loaded",
    }
  }, [whisperContext, llamaContext, ttsIsReady, whisper, llama, tts])

  // Initialize all models
  const initializeAll = useCallback(
    async (options?: {
      whisperModel?: string
      llamaModel?: string
      ttsModel?: string
    }) => {
      setError(null)
      setPipelineState("idle")

      try {
        // Initialize Whisper
        if (!whisperContext) {
          const whisperModelId =
            options?.whisperModel || mergedConfig.whisperModel || "tiny"
          tLog(`Initializing Whisper with model: ${whisperModelId}...`)
          await initializeWhisperModel(whisperModelId)
        }

        // Initialize Llama
        if (!llamaContext) {
          const llamaModelId =
            options?.llamaModel || mergedConfig.llamaModel || "gemma-2b-it"
          tLog(`Initializing Llama with model: ${llamaModelId}...`)
          await initializeLlamaModel(llamaModelId, {})
        }

        // Initialize TTS (use FP32 - RTF ~0.9)
        const ttsAlreadyReady = ttsIsReady()
        const currentModel = ttsGetCurrentModel()
        const ttsSource = mergedConfig.ttsModelSource || "default"
        tLog(
          `TTS Status: ready=${ttsAlreadyReady}, currentModel=${
            currentModel?.id || "none"
          }, source=${ttsSource}`
        )

        if (!ttsAlreadyReady) {
          tLog("Initializing TTS...")
          // Switch to the selected source (downloads if needed)
          await ttsSwitchModelSource(ttsSource)

          // Now refresh and check models - using direct tts ref here as it's an action
          const models = await tts.refreshModelFiles(ttsSource)
          tLog("Available TTS models:", Object.keys(models))

          // Use BERT model for bert source, FP32 for others
          const availableTtsModel = options?.ttsModel || (ttsSource === "bert" ? "melo-bert" : "melo-fp32")
          tLog(
            `Loading TTS model: ${availableTtsModel} from source: ${ttsSource}`
          )
          await ttsInitializeModel(availableTtsModel, ttsSource)
          tLog(
            `TTS initialized with: ${tts.getCurrentModel()?.id || "unknown"}`
          )
        } else {
          // Check if we need to switch sources
          if (ttsCurrentModelSource !== ttsSource) {
            tLog(
              `Switching TTS source from ${ttsCurrentModelSource} to ${ttsSource}...`
            )
            await ttsSwitchModelSource(ttsSource)
            // Use BERT model for bert source, FP32 for others
            const availableTtsModel = options?.ttsModel || (ttsSource === "bert" ? "melo-bert" : "melo-fp32")
            // Pass source explicitly to avoid state timing issues
            await ttsInitializeModel(availableTtsModel, ttsSource)
            tLog(
              `TTS re-initialized with: ${
                tts.getCurrentModel()?.id || "unknown"
              }`
            )
          } else {
            tLog(`TTS already initialized with: ${currentModel?.id}`)
          }
        }

        tLog("All models initialized!")
        return true
      } catch (err) {
        const errorMsg = `Failed to initialize models: ${err}`
        console.error(errorMsg)
        setError(errorMsg)
        return false
      }
    },
    [whisperContext, llamaContext, ttsIsReady, ttsCurrentModelSource, initializeWhisperModel, initializeLlamaModel, ttsSwitchModelSource, ttsInitializeModel, mergedConfig.whisperModel, mergedConfig.llamaModel, mergedConfig.ttsModelSource, tts]
  )

  // Switch TTS source at runtime (downloads if needed, then re-initializes)
  const switchTTSSource = useCallback(
    async (newSource: ModelSource) => {
      if (pipelineState !== "idle") {
        console.warn("Cannot switch TTS source while pipeline is active")
        return false
      }

      try {
        setError(null)
        tLog(`Switching TTS source to: ${newSource}`)

        // Switch model source (downloads if needed)
        await ttsSwitchModelSource(newSource)

        // Re-initialize with appropriate model from the new source
        // BERT source uses melo-bert, others use melo-fp32
        const modelToUse = newSource === "bert" ? "melo-bert" : "melo-fp32"
        // Pass the source explicitly to avoid state timing issues
        await ttsInitializeModel(modelToUse, newSource)

        tLog(
          `TTS switched to ${newSource} with model: ${
            tts.getCurrentModel()?.id || "unknown"
          }`
        )
        return true
      } catch (err) {
        const errorMsg = `Failed to switch TTS source: ${err}`
        console.error(errorMsg)
        setError(errorMsg)
        return false
      }
    },
    [ttsSwitchModelSource, ttsInitializeModel, tts, pipelineState]
  )

  // Switch LLM model at runtime (downloads if needed, then re-initializes)
  const switchLLMModel = useCallback(
    async (modelId: string) => {
      if (pipelineState !== "idle") {
        console.warn("Cannot switch LLM model while pipeline is active")
        return false
      }

      try {
        setError(null)
        tLog(`Switching LLM model to: ${modelId}...`)

        // Release existing context first
        if (llamaContext) {
          await releaseContext()
        }

        // Initialize the new model (downloads if needed)
        await initializeLlamaModel(modelId, {})

        tLog(`LLM switched to: ${llama.getCurrentModel()?.label || modelId}`)
        return true
      } catch (err) {
        const errorMsg = `Failed to switch LLM model: ${err}`
        console.error(errorMsg)
        setError(errorMsg)
        return false
      }
    },
    [llamaContext, releaseContext, initializeLlamaModel, llama, pipelineState]
  )

  // Helper to count words in text
  const countWords = useCallback((text: string): number => {
    return text
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length
  }, [])

  // Extract phrases from accumulated text for TTS
  // Rules:
  // 1. Don't break on 'and' (too common)
  // 2. Minimum 6 words per phrase
  // 3. Only break when we have >=6 words AND hit break punctuation or conjunction
  // 4. If last phrase has <6 words, keep accumulating
  // 5. First chunk: force break at 8 words for faster time-to-first-audio
  const extractSentences = useCallback(
    (text: string): { sentences: string[]; remainder: string } => {
      const phrases: string[] = []
      let currentPhrase = ""
      let remainder = text

      // Process character by character to find natural break points
      let i = 0
      while (i < text.length) {
        currentPhrase += text[i]

        // Check if we hit a break punctuation
        const lastChar = text[i]
        const isPunctuation = PHRASE_BREAK_PUNCTUATION.test(lastChar)

        // Look ahead for conjunction after space
        let isConjunction = false
        if (text[i] === " " && i + 1 < text.length) {
          const remainingText = text.substring(i + 1)
          const conjMatch = remainingText.match(
            /^(but|so|because|although|however|therefore|meanwhile|furthermore)\b/i
          )
          if (conjMatch) {
            isConjunction = true
          }
        }

        const wordCount = countWords(currentPhrase)

        // Break only on punctuation or conjunction (with minimum word count)
        if (isPunctuation || isConjunction) {
          if (wordCount >= MIN_WORDS_PER_PHRASE) {
            // For punctuation, include it; for conjunction, don't include the space
            if (isPunctuation) {
              phrases.push(currentPhrase.trim())
              currentPhrase = ""
            } else if (isConjunction) {
              // Break before the conjunction
              phrases.push(currentPhrase.trim())
              currentPhrase = ""
            }
          }
          // If not enough words, keep accumulating
        }

        i++
      }

      // Whatever is left is the remainder
      remainder = currentPhrase.trim()

      // If remainder has break punctuation at the end AND enough words, it's a complete phrase
      if (remainder.length > 0) {
        const lastCharOfRemainder = remainder[remainder.length - 1]
        const endsWithPunctuation =
          PHRASE_BREAK_PUNCTUATION.test(lastCharOfRemainder)
        const wordCount = countWords(remainder)

        if (endsWithPunctuation && wordCount >= MIN_WORDS_PER_PHRASE) {
          phrases.push(remainder)
          remainder = ""
        }
      }

      if (phrases.length > 0 || remainder.length > 0) {
        tLog(
          `📊 Extracted ${phrases.length} phrases (${phrases
            .map((p) => countWords(p) + "w")
            .join(", ")}), remainder: ${countWords(
            remainder
          )}w "${remainder.substring(0, 30)}${
            remainder.length > 30 ? "..." : ""
          }"`
        )
      }

      return { sentences: phrases, remainder }
    },
    [countWords]
  )

  // Clean text for TTS - remove non-English characters and normalize
  const cleanTextForTTS = useCallback((text: string): string => {
    // Remove special tags like <conv_completed/>
    let cleaned = text.replace(/<[^>]+\/?>/g, "")
    // Remove non-ASCII characters (keeps English, numbers, punctuation)
    cleaned = cleaned.replace(/[^\x00-\x7F]/g, " ")
    // Handle ellipsis: convert "..." or ".." to comma (natural pause)
    cleaned = cleaned.replace(/\.{2,}/g, ",")
    // Remove extra whitespace
    cleaned = cleaned.replace(/\s+/g, " ").trim()
    // Remove any remaining control characters
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, "")
    // Replace trailing punctuation (comma, semicolon, colon) with period for better TTS prosody
    // Keep ! and ? as they affect intonation
    cleaned = cleaned.replace(/[,;:]$/, ".")
    // Ensure phrase ends with punctuation (add period if missing)
    if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
      cleaned += "."
    }
    return cleaned
  }, [])

  // Queue a phrase for TTS
  const queueSentenceForTTS = useCallback(
    (sentence: string) => {
      // Debug: log original sentence before cleaning
      tLog(`🔍 Original phrase (${sentence.length} chars): "${sentence}"`)
      
      // Clean the text first
      const cleanedText = cleanTextForTTS(sentence)
      
      // Debug: log cleaned text
      tLog(`🔍 Cleaned phrase (${cleanedText.length} chars): "${cleanedText}"`)

      // Skip if too short or empty after cleaning
      if (cleanedText.length < 3) {
        tLog(`⏭️ Skipping too short phrase: "${sentence}"`)
        return null
      }

      const id = `tts-${Date.now()}-${queueIdCounterRef.current++}`

      const newItem: TTSQueueItem = {
        id,
        text: cleanedText,
        status: "pending",
      }

      tLog(
        `📝 Queuing phrase for TTS: "${cleanedText.substring(0, 50)}${
          cleanedText.length > 50 ? "..." : ""
        }"`
      )

      setTtsQueue((prev) => [...prev, newItem])
      return id
    },
    [cleanTextForTTS]
  )

  // Synthesize a queued sentence
  const synthesizeSentence = useCallback(
    async (item: TTSQueueItem): Promise<TTSQueueItem | null> => {
      if (synthesisAbortRef.current) return null

      try {
        // Update status
        setTtsQueue((prev) =>
          prev.map((i) =>
            i.id === item.id ? { ...i, status: "synthesizing" } : i
          )
        )

        // Debug: Log current TTS model
        const currentTTSModel = tts.getCurrentModel()
        tLog(
          `🔊 Synthesizing with model: ${
            currentTTSModel?.label || "UNKNOWN"
          } (${currentTTSModel?.id || "no-id"})`
        )
        tLog(`🔊 Text: "${item.text.substring(0, 30)}..."`)
        tLog(`🔊 TTS Ready: ${ttsIsReady()}`)

        // Get TTS directory
        const directory = await ttsGetModelDirectory()
        const outputPath = new File(directory, `voice_${item.id}.wav`).uri

        // Synthesize - now returns actual audio duration
        const startTime = Date.now()
        const { audioDuration } = await ttsSynthesizeToFile(item.text, outputPath, {
          lengthScale: mergedConfig.ttsSpeed,
          noiseScale: mergedConfig.ttsNaturalness,
          noiseScaleW: mergedConfig.ttsNoiseScaleW,
        })
        const synthesisTime = (Date.now() - startTime) / 1000

        tLog(
          `✅ Synthesized in ${synthesisTime.toFixed(2)}s, audio duration: ${audioDuration.toFixed(2)}s: "${item.text.substring(
            0,
            30
          )}..."`
        )

        // Update queue with audio path and ACTUAL audio duration (not synthesis time)
        const updatedItem: TTSQueueItem = {
          ...item,
          status: "ready",
          audioPath: outputPath,
          audioDuration: audioDuration, // Use actual audio duration from TTS
        }

        setTtsQueue((prev) =>
          prev.map((i) => (i.id === item.id ? updatedItem : i))
        )

        return updatedItem
      } catch (err) {
        console.error(`TTS synthesis failed for "${item.text}":`, err)
        setTtsQueue((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, status: "done" } : i))
        )
        return null
      }
    },
    [ttsIsReady, ttsGetModelDirectory, ttsSynthesizeToFile, mergedConfig, tts]
  )

  // Estimate audio duration from text (more reliable than synthesis time)
  // TTS typically produces ~150 words/minute = 2.5 words/second
  const estimateAudioDuration = useCallback((text: string): number => {
    const wordCount = text
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length
    // Base estimate: 2.5 words per second, with minimum 0.5s
    return Math.max(0.5, wordCount / 2.5)
  }, [])

  // Play a single audio item and wait for completion
  const playSingleItem = useCallback(
    async (item: TTSQueueItem): Promise<void> => {
      if (!item.audioPath) return

      try {
        setTtsQueue((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, status: "playing" } : i))
        )
        setCurrentPlayingId(item.id)

        tLog(`▶️ Playing: "${item.text.substring(0, 30)}..."`)

        // Create audio player
        const player = new AudioModule.AudioPlayer(
          { uri: item.audioPath },
          100,
          false
        )
        audioPlayersRef.current.set(item.id, player)

        // Set playback rate
        const playbackRate = mergedConfig.playbackRate ?? 1.0
        player.setPlaybackRate(playbackRate, "high")

        // Record start time, then start playback
        const playStartTime = Date.now()
        player.play()

        // Use the ACTUAL audio duration from TTS synthesis (most accurate)
        // This is calculated from samples/sampleRate during synthesis
        let actualDuration = item.audioDuration

        // Fallback 1: Try to get duration from player if not available from synthesis
        if (!actualDuration || actualDuration <= 0) {
          await new Promise((r) => setTimeout(r, 50))
          actualDuration = player.duration

          // Poll for duration if not immediately available (max 500ms)
          if (!actualDuration || actualDuration <= 0) {
            for (let i = 0; i < 10; i++) {
              await new Promise((r) => setTimeout(r, 50))
              actualDuration = player.duration
              if (actualDuration && actualDuration > 0) break
            }
          }
        }

        // Fallback 2: Estimate from word count if all else fails
        if (!actualDuration || actualDuration <= 0) {
          const wordCount = item.text.trim().split(/\s+/).length
          actualDuration = Math.max(0.5, wordCount / 2.5) * 1.2 // Account for slow TTS
          tLog(
            `⚠️ Duration unavailable, using fallback estimate: ${actualDuration.toFixed(
              2
            )}s`
          )
        } else {
          tLog(
            `📊 Using TTS-reported duration: ${actualDuration.toFixed(2)}s`
          )
        }

        const adjustedDuration = actualDuration / playbackRate

        // Calculate remaining wait time (subtract time already elapsed since play started)
        // Add 300ms safety buffer to ensure audio fully completes before cleanup
        // (accounts for setTimeout inaccuracy, audio system latency, and buffer flushing)
        const PLAYBACK_SAFETY_BUFFER_MS = 300
        const elapsedSincePlay = Date.now() - playStartTime
        const waitTime = Math.max(0, adjustedDuration * 1000 - elapsedSincePlay + PLAYBACK_SAFETY_BUFFER_MS)

        tLog(
          `⏱️ Duration: ${actualDuration.toFixed(
            2
          )}s (adjusted: ${adjustedDuration.toFixed(2)}s at ${playbackRate}x), waiting: ${waitTime.toFixed(
            0
          )}ms (includes ${PLAYBACK_SAFETY_BUFFER_MS}ms buffer)`
        )

        await new Promise<void>((resolve) => {
          setTimeout(resolve, waitTime)
        })

        // Cleanup player - don't call pause(), just remove()
        // Calling pause() can interrupt audio that's still flushing through the audio system
        // This matches the TTS tab behavior which never calls pause()
        player.remove()
        audioPlayersRef.current.delete(item.id)

        // Mark as done
        setTtsQueue((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, status: "done" } : i))
        )
        setCurrentPlayingId(null)

        // Delete the audio file to save space
        try {
          const file = new File(item.audioPath)
          if (file.exists) file.delete()
        } catch (e) {
          console.warn("Failed to cleanup audio file:", e)
        }
      } catch (err) {
        console.error("Audio playback error:", err)
        setCurrentPlayingId(null)
        // Mark as done even on error
        setTtsQueue((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, status: "done" } : i))
        )
      }
    },
    [mergedConfig.playbackRate]
  )

  // Determine pause duration based on how the text ends
  const getPauseDuration = useCallback((text: string): number => {
    const trimmed = text.trim()
    if (!trimmed) return 0
    const lastChar = trimmed[trimmed.length - 1]

    // Sentence endings get longer pause
    if (lastChar === "." || lastChar === "?") {
      return PAUSE_AFTER_SENTENCE
    }
    // Comma/clause breaks get shorter pause
    if (lastChar === "," || lastChar === ";" || lastChar === ":") {
      return PAUSE_AFTER_COMMA
    }
    // Exclamation or other - small pause
    if (lastChar === "!") {
      return PAUSE_AFTER_COMMA // Treat exclamation like comma (brief pause)
    }
    return 0
  }, [])

  // Sequential playback chain - processes items one by one without useEffect races
  const runPlaybackChain = useCallback(async () => {
    // Only one chain can run at a time
    if (isPlaybackChainRunningRef.current) return
    isPlaybackChainRunningRef.current = true
    isPlaybackInProgressRef.current = true

    tLog("🔗 Starting playback chain")

    try {
      let previousItemText: string | null = null

      while (true) {
        // Get next item from the ref-based queue
        const nextItem = playbackQueueRef.current.shift()
        if (!nextItem) break

        // Add pause AFTER previous item based on its ending punctuation
        if (previousItemText !== null) {
          const pauseDuration = getPauseDuration(previousItemText)
          if (pauseDuration > 0) {
            tLog(
              `⏸️ Pause: ${pauseDuration}ms after "${previousItemText.slice(
                -10
              )}"`
            )
            await new Promise((r) => setTimeout(r, pauseDuration))
          }
        }

        tLog(`🎵 Chain playing item: "${nextItem.text.substring(0, 30)}..."`)
        await playSingleItem(nextItem)

        // Track this item for the next pause calculation
        previousItemText = nextItem.text
      }
    } finally {
      isPlaybackChainRunningRef.current = false
      isPlaybackInProgressRef.current = false
      tLog("🔗 Playback chain complete")
    }
  }, [playSingleItem, getPauseDuration])

  // Add item to playback queue and start chain if not running
  const enqueueForPlayback = useCallback(
    (item: TTSQueueItem) => {
      playbackQueueRef.current.push(item)
      tLog(
        `📥 Enqueued for playback: "${item.text.substring(
          0,
          30
        )}..." (queue size: ${playbackQueueRef.current.length})`
      )

      // Start the chain if not already running
      if (!isPlaybackChainRunningRef.current) {
        runPlaybackChain()
      }
    },
    [runPlaybackChain]
  )

  // Track which items have been enqueued for playback (to avoid double-enqueue)
  const enqueuedItemsRef = useRef<Set<string>>(new Set())

  // Effect to process TTS queue - handles synthesis and enqueues ready items
  useEffect(() => {
    // Find pending items to synthesize (up to maxConcurrentSynthesis)
    const pendingItems = ttsQueue.filter((item) => item.status === "pending")
    const synthesizingCount = ttsQueue.filter(
      (item) => item.status === "synthesizing"
    ).length
    const playingCount = ttsQueue.filter(
      (item) => item.status === "playing"
    ).length
    const readyItems = ttsQueue.filter((item) => item.status === "ready")
    const availableSlots =
      (mergedConfig.maxConcurrentSynthesis || 1) - synthesizingCount

    // Calculate total ready audio duration for buffer check
    const totalReadyDuration = readyItems.reduce(
      (sum, item) => sum + estimateAudioDuration(item.text),
      0
    )
    const hasEnoughBuffer = totalReadyDuration >= MIN_AUDIO_BUFFER_SECONDS
    const isLLMDone = pipelineState !== "thinking"

    // Debug: Log queue state
    if (ttsQueue.length > 0) {
      tLog(
        `🎯 Queue: pending=${
          pendingItems.length
        }, synthesizing=${synthesizingCount}, ready=${
          readyItems.length
        } (${totalReadyDuration.toFixed(1)}s), playing=${playingCount}`
      )
    }

    // Start synthesis for pending items (can synthesize while playing!)
    for (let i = 0; i < Math.min(pendingItems.length, availableSlots); i++) {
      tLog(
        `🚀 Starting synthesis for chunk while ${
          playingCount > 0 ? "PLAYING" : "idle"
        }`
      )
      synthesizeSentence(pendingItems[i])
    }

    // Enqueue ready items for playback (only if not already enqueued)
    // Check buffer condition: start when we have enough buffer OR LLM is done
    const shouldStartPlayback =
      hasEnoughBuffer ||
      (isLLMDone && pendingItems.length === 0 && synthesizingCount === 0)

    if (shouldStartPlayback) {
      for (const item of readyItems) {
        if (!enqueuedItemsRef.current.has(item.id)) {
          enqueuedItemsRef.current.add(item.id)
          enqueueForPlayback(item)
        }
      }
    } else if (readyItems.length > 0) {
      tLog(
        `⏳ Waiting for ${MIN_AUDIO_BUFFER_SECONDS}s buffer (current: ${totalReadyDuration.toFixed(
          1
        )}s)`
      )
    }

    // Check if all items are done
    const allDone =
      ttsQueue.length > 0 && ttsQueue.every((item) => item.status === "done")
    if (allDone && pipelineState === "speaking") {
      setPipelineState("idle")
      setTtsQueue([])
      enqueuedItemsRef.current.clear() // Reset for next conversation
    }
  }, [
    ttsQueue,
    pipelineState,
    mergedConfig.maxConcurrentSynthesis,
    synthesizeSentence,
    enqueueForPlayback,
    estimateAudioDuration,
  ])

  // Handle LLM token callback - detect sentences and queue for TTS
  const handleLLMToken = useCallback(
    (token: string) => {
      // Accumulate the token
      accumulatedTextRef.current += token
      setLlmResponse(accumulatedTextRef.current)

      // Check for complete sentences
      const { sentences, remainder } = extractSentences(
        accumulatedTextRef.current
      )

      // Queue new sentences for TTS
      for (const sentence of sentences) {
        if (!processedSentencesRef.current.has(sentence)) {
          tLog(`✅ Extracted & queuing sentence: "${sentence.substring(0, 50)}${sentence.length > 50 ? '...' : ''}"`)
          processedSentencesRef.current.add(sentence)
          queueSentenceForTTS(sentence)
        } else {
          tLog(`⚠️ Skipping duplicate sentence during streaming: "${sentence.substring(0, 50)}..."`)
        }
      }

      // Update accumulated text to just the remainder
      accumulatedTextRef.current = remainder
    },
    [extractSentences, queueSentenceForTTS]
  )

  // Handle completion of LLM response
  const handleLLMComplete = useCallback(() => {
    // Queue any remaining text
    const remainingText = accumulatedTextRef.current.trim()
    tLog(`🏁 LLM Complete - Remaining text (${remainingText.length} chars): "${remainingText}"`)
    
    if (remainingText.length > 0) {
      // Check if already processed (for logging purposes)
      const alreadyProcessed = processedSentencesRef.current.has(remainingText)
      if (alreadyProcessed) {
        tLog(`⚠️ Remainder was already in processedSentences - queueing anyway to avoid skipping`)
        tLog(`   Processed sentences: ${Array.from(processedSentencesRef.current).map(s => `"${s.substring(0, 30)}..."`).join(", ")}`)
      }
      // Always queue remainder text - don't skip even if it appears to be duplicate
      // The remainder is the final piece and should never be skipped
      processedSentencesRef.current.add(remainingText)
      queueSentenceForTTS(remainingText)
    }

    // Clear accumulators
    accumulatedTextRef.current = ""
  }, [queueSentenceForTTS])

  // Start listening for voice input
  const startListening = useCallback(async () => {
    if (!whisperContext) {
      setError("Whisper not initialized")
      return false
    }

    try {
      setError(null)
      setPipelineState("listening")
      setCurrentTranscription("")
      setFinalTranscription("")
      setLlmResponse("")
      setTtsQueue([])
      synthesisAbortRef.current = false
      accumulatedTextRef.current = ""
      processedSentencesRef.current.clear()
      playbackQueueRef.current = []
      enqueuedItemsRef.current.clear()

      tLog("🎤 Starting voice input...")

      const { stop, subscribe } =
        await whisperContext.transcribeRealtime({
          language: "en",
          realtimeAudioSec: 300,  // 5 minutes session (matches Whisper demo tab)
          realtimeAudioSliceSec: 10,  // Increased from 5 to 10 for better transcription quality (more context per chunk)
          realtimeAudioMinSec: 1,
          audioSessionOnStartIos: {
            category: "PlayAndRecord" as any,
            options: ["MixWithOthers" as any],
            mode: "Default" as any,
          },
          audioSessionOnStopIos: "restore" as any,
        })

      currentTranscriberRef.current = { stop }

      subscribe((event: any) => {
        const { isCapturing, data } = event

        if (data?.result) {
          const transcript = data.result.trim()
          setCurrentTranscription(transcript)
          tLog(`📝 Transcription: ${transcript}`)
        }
      })

      return true
    } catch (err) {
      const errorMsg = `Failed to start listening: ${err}`
      console.error(errorMsg)
      setError(errorMsg)
      setPipelineState("error")
      return false
    }
  }, [whisperContext])

  // Stop listening and process the transcription
  const stopListeningAndProcess = useCallback(async () => {
    try {
      // Stop transcription
      if (currentTranscriberRef.current?.stop) {
        await currentTranscriberRef.current.stop()
        currentTranscriberRef.current = null
      }

      const finalText = currentTranscription.trim()
      setFinalTranscription(finalText)

      if (!finalText) {
        tLog("No transcription captured")
        setPipelineState("idle")
        return
      }

      tLog(`🎯 Final transcription: "${finalText}"`)

      // Transition to thinking state
      setPipelineState("thinking")

      // Add user message to history
      const userMessage: ChatMessage = {
        role: "user",
        content: finalText,
      }

      const newHistory = [...conversationHistory, userMessage]
      setConversationHistory(newHistory)

      // Build messages for LLM
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: mergedConfig.systemPrompt || DEFAULT_CONFIG.systemPrompt!,
        },
        ...newHistory,
      ]

      // Start LLM completion with streaming
      tLog("🤖 Starting LLM completion...")
      setPipelineState("speaking") // Transition to speaking as we'll start TTS soon

      const response = await completion(messages, handleLLMToken)

      // Handle completion
      handleLLMComplete()

      // Add assistant response to history
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response,
      }
      setConversationHistory((prev) => [...prev, assistantMessage])

      tLog("✅ LLM response complete")
    } catch (err) {
      const errorMsg = `Processing failed: ${err}`
      console.error(errorMsg)
      setError(errorMsg)
      setPipelineState("error")
    }
  }, [
    currentTranscription,
    conversationHistory,
    completion,
    mergedConfig.systemPrompt,
    handleLLMToken,
    handleLLMComplete,
  ])

  // Send a text message (skip transcription, go directly to LLM)
  const sendTextMessage = useCallback(
    async (text: string) => {
      const trimmedText = text.trim()
      if (!trimmedText) {
        tLog("Empty text message, ignoring")
        return
      }

      if (pipelineState !== "idle") {
        console.log("Pipeline busy, cannot send text")
        return
      }

      try {
        setError(null)
        setFinalTranscription(trimmedText)
        setLlmResponse("")
        setTtsQueue([])
        synthesisAbortRef.current = false
        accumulatedTextRef.current = ""
        processedSentencesRef.current.clear()
        playbackQueueRef.current = []
        enqueuedItemsRef.current.clear()

        console.log(`💬 Text message: "${trimmedText}"`)

        // Transition to thinking state
        setPipelineState("thinking")

        // Add user message to history
        const userMessage: ChatMessage = {
          role: "user",
          content: trimmedText,
        }

        const newHistory = [...conversationHistory, userMessage]
        setConversationHistory(newHistory)

        // Build messages for LLM
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: mergedConfig.systemPrompt || DEFAULT_CONFIG.systemPrompt!,
          },
          ...newHistory,
        ]

        // Start LLM completion with streaming
        tLog("🤖 Starting LLM completion...")
        setPipelineState("speaking")

        const response = await completion(messages, handleLLMToken)

        // Handle completion
        handleLLMComplete()

        // Add assistant response to history
        const assistantMessage: ChatMessage = {
          role: "assistant",
          content: response,
        }
        setConversationHistory((prev) => [...prev, assistantMessage])

        tLog("✅ LLM response complete")
      } catch (err) {
        const errorMsg = `Text processing failed: ${err}`
        console.error(errorMsg)
        setError(errorMsg)
        setPipelineState("error")
      }
    },
    [
      pipelineState,
      conversationHistory,
      completion,
      mergedConfig.systemPrompt,
      handleLLMToken,
      handleLLMComplete,
    ]
  )

  // Cancel current operation
  const cancel = useCallback(async () => {
    synthesisAbortRef.current = true
    isPlaybackInProgressRef.current = false // Reset playback lock
    isPlaybackChainRunningRef.current = false // Stop playback chain

    // Clear playback queue
    playbackQueueRef.current = []
    enqueuedItemsRef.current.clear()

    // Stop transcription
    if (currentTranscriberRef.current?.stop) {
      try {
        await currentTranscriberRef.current.stop()
      } catch (e) {
        console.warn("Error stopping transcription:", e)
      }
      currentTranscriberRef.current = null
    }

    // Stop all audio
    audioPlayersRef.current.forEach((player, id) => {
      try {
        player.pause()
        player.remove()
      } catch (e) {
        console.warn("Error stopping audio player:", e)
      }
    })
    audioPlayersRef.current.clear()

    // Stop TTS
    ttsStopAudio()

    // Reset state
    setPipelineState("idle")
    setCurrentTranscription("")
    setLlmResponse("")
    setTtsQueue([])
    setCurrentPlayingId(null)

    console.log("🛑 Pipeline cancelled")
  }, [ttsStopAudio])

  // Clear conversation history
  const clearHistory = useCallback(() => {
    setConversationHistory([])
    setFinalTranscription("")
    setLlmResponse("")
    console.log("📜 Conversation history cleared")
  }, [])

  // Synthesize and play a single phrase (for initial greetings, etc.)
  const synthesizeAndPlay = useCallback(
    async (text: string): Promise<void> => {
      if (!ttsIsReady()) {
        throw new Error("TTS not ready")
      }

      const cleanedText = cleanTextForTTS(text)
      if (cleanedText.length < 3) return

      try {
        setPipelineState("speaking")

        // Get TTS directory and create output path
        const directory = await ttsGetModelDirectory()
        const outputPath = new File(
          directory,
          `voice_greeting_${Date.now()}.wav`
        ).uri

        // Synthesize - now returns actual audio duration
        const { audioDuration } = await ttsSynthesizeToFile(cleanedText, outputPath, {
          lengthScale: mergedConfig.ttsSpeed,
          noiseScale: mergedConfig.ttsNaturalness,
          noiseScaleW: mergedConfig.ttsNoiseScaleW,
        })

        // Play the audio
        const player = new AudioModule.AudioPlayer(
          { uri: outputPath },
          100,
          false
        )

        const playbackRate = mergedConfig.playbackRate ?? 1.0
        player.setPlaybackRate(playbackRate, "high")

        player.play()

        // Use the ACTUAL audio duration from TTS synthesis (most accurate)
        let duration = audioDuration

        // Fallback: try player duration if TTS duration unavailable
        if (!duration || duration <= 0) {
          await new Promise((r) => setTimeout(r, 50))
          duration = player.duration
          if (!duration || duration <= 0) {
            for (let i = 0; i < 10; i++) {
              await new Promise((r) => setTimeout(r, 50))
              duration = player.duration
              if (duration && duration > 0) break
            }
          }
        }

        // Fallback: estimate from word count
        if (!duration || duration <= 0) {
          const wordCount = cleanedText.trim().split(/\s+/).length
          duration = Math.max(0.5, wordCount / 2.5)
        }

        tLog(`📊 Greeting playback duration: ${duration.toFixed(2)}s`)

        // Wait for playback to complete (with safety buffer for audio system latency)
        const PLAYBACK_SAFETY_BUFFER_MS = 300
        const adjustedDuration = duration / playbackRate
        await new Promise((resolve) =>
          setTimeout(resolve, adjustedDuration * 1000 + PLAYBACK_SAFETY_BUFFER_MS)
        )

        // Cleanup - don't call pause(), just remove()
        // Calling pause() can interrupt audio still flushing through the system
        player.remove()

        try {
          const file = new File(outputPath)
          if (file.exists) file.delete()
        } catch (e) {}

        setPipelineState("idle")
      } catch (err) {
        console.error("synthesizeAndPlay error:", err)
        setPipelineState("idle")
        throw err
      }
    },
    [
      ttsIsReady,
      ttsGetModelDirectory,
      ttsSynthesizeToFile,
      cleanTextForTTS,
      mergedConfig.ttsSpeed,
      mergedConfig.ttsNaturalness,
      mergedConfig.ttsNoiseScaleW,
      mergedConfig.playbackRate,
    ]
  )

  // Cleanup on unmount - just cancel any ongoing operations
  // Note: We don't release contexts here to allow reuse across screen navigations
  // Contexts are managed by VoiceAssistantProvider at the app level
  useEffect(() => {
    return () => {
      cancel()
    }
  }, [cancel])

  return {
    // State
    pipelineState,
    error,
    currentTranscription,
    finalTranscription,
    llmResponse,
    conversationHistory,
    ttsQueue,
    currentPlayingId,

    // Status
    isReady,
    getInitStatus,

    // Model loading states
    isWhisperLoading: isWhisperInitializing,
    isLlamaLoading: isLlamaInitializing,
    isTTSLoading: isTtsInitializing,

    // Actions
    initializeAll,
    startListening,
    stopListeningAndProcess,
    sendTextMessage,
    synthesizeAndPlay,
    cancel,
    clearHistory,
    switchTTSSource,
    switchLLMModel,

    // Individual hooks access (for advanced usage)
    whisper,
    llama,
    tts,
  }
}
