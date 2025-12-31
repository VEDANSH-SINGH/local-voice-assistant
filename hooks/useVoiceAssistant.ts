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
import { useState, useCallback, useRef, useEffect } from "react";
import { useWhisperModels } from "./useWhisperModels";
import { useLlamaModels, ChatMessage } from "./useLlamaModels";
import { useMeloTTS } from "./useMeloTTS";
import { File, Paths, Directory } from "expo-file-system";
import AudioModule from "expo-audio/build/AudioModule";

// Helper to get formatted timestamp for logs
const getTimestamp = () => {
  const now = new Date();
  return `[${now.toLocaleTimeString('en-US', { hour12: false })}.${now.getMilliseconds().toString().padStart(3, '0')}]`;
};

// Timestamped log helper
const tLog = (...args: any[]) => console.log(getTimestamp(), ...args);

// Pipeline states
export type PipelineState = 
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

// Sentence in the TTS queue
interface TTSQueueItem {
  id: string;
  text: string;
  status: "pending" | "synthesizing" | "ready" | "playing" | "done";
  audioPath?: string;
  audioDuration?: number;
}

// Configuration for the assistant
export interface VoiceAssistantConfig {
  systemPrompt?: string;
  minSentenceLength?: number;
  maxConcurrentSynthesis?: number;
  ttsSpeed?: number;
  ttsNaturalness?: number;
}

const DEFAULT_CONFIG: VoiceAssistantConfig = {
  systemPrompt: "You are a helpful, friendly AI assistant. Keep your responses concise and conversational, suitable for voice interaction. Respond in 2-3 sentences when possible.",
  minSentenceLength: 6,  // Reduced for phrase-level chunking
  maxConcurrentSynthesis: 1,  // One at a time to reduce CPU competition
  ttsSpeed: 1.0,
  ttsNaturalness: 0.6,
};

// Minimum audio buffer (in seconds) before starting playback
const MIN_AUDIO_BUFFER_SECONDS = 3.0;

// Phrase boundary detection - split on commas, semicolons, colons, and sentence endings
// This creates smaller chunks for faster time-to-first-audio
const PHRASE_SPLIT_REGEX = /(?<=[,;:.!?])\s+/;
// Also split on conjunctions that start a new clause
const CONJUNCTION_SPLIT_REGEX = /\s+(?=(?:and|but|or|so|because|although|however|therefore|meanwhile|furthermore)\s)/i;

export function useVoiceAssistant(config: VoiceAssistantConfig = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  
  // Pipeline state
  const [pipelineState, setPipelineState] = useState<PipelineState>("idle");
  const [error, setError] = useState<string | null>(null);
  
  // Transcription state
  const [currentTranscription, setCurrentTranscription] = useState<string>("");
  const [finalTranscription, setFinalTranscription] = useState<string>("");
  
  // LLM state
  const [llmResponse, setLlmResponse] = useState<string>("");
  const [conversationHistory, setConversationHistory] = useState<ChatMessage[]>([]);
  
  // TTS queue state
  const [ttsQueue, setTtsQueue] = useState<TTSQueueItem[]>([]);
  const [currentPlayingId, setCurrentPlayingId] = useState<string | null>(null);
  
  // Audio players pool
  const audioPlayersRef = useRef<Map<string, any>>(new Map());
  const synthesisAbortRef = useRef<boolean>(false);
  const currentTranscriberRef = useRef<any>(null);
  
  // Accumulated text for sentence detection
  const accumulatedTextRef = useRef<string>("");
  const processedSentencesRef = useRef<Set<string>>(new Set());
  const queueIdCounterRef = useRef<number>(0);
  
  // Hooks
  const whisper = useWhisperModels();
  const llama = useLlamaModels();
  const tts = useMeloTTS();

  // Check if all models are ready
  const isReady = useCallback(() => {
    return whisper.whisperContext !== null && 
           llama.llamaContext !== null && 
           tts.isReady();
  }, [whisper.whisperContext, llama.llamaContext, tts]);

  // Get initialization status
  const getInitStatus = useCallback(() => {
    return {
      whisper: whisper.whisperContext !== null,
      llama: llama.llamaContext !== null,
      tts: tts.isReady(),
      whisperModel: whisper.getCurrentModel()?.label || "Not loaded",
      llamaModel: llama.getCurrentModel()?.label || "Not loaded",
      ttsModel: tts.getCurrentModel()?.label || "Not loaded",
    };
  }, [whisper, llama, tts]);

  // Initialize all models
  const initializeAll = useCallback(async (options?: {
    whisperModel?: string;
    llamaModel?: string;
    ttsModel?: string;
  }) => {
    setError(null);
    setPipelineState("idle");
    
    try {
      // Initialize Whisper (use tiny for fastest transcription)
      if (!whisper.whisperContext) {
        tLog("Initializing Whisper...");
        await whisper.initializeWhisperModel(options?.whisperModel || "tiny");
      }
      
      // Initialize Llama
      if (!llama.llamaContext) {
        tLog("Initializing Llama...");
        await llama.initializeLlamaModel(options?.llamaModel || "gemma-3-270m", {});
      }
      
      // Initialize TTS (use FP32 - RTF ~0.9)
      const ttsAlreadyReady = tts.isReady();
      const currentModel = tts.getCurrentModel();
      tLog(`TTS Status: ready=${ttsAlreadyReady}, currentModel=${currentModel?.id || 'none'}`);
      
      if (!ttsAlreadyReady) {
        tLog("Initializing TTS...");
        // First check if models are downloaded
        const models = await tts.refreshModelFiles();
        tLog("Available TTS models:", Object.keys(models));
        if (!models["melo-int8"] && !models["melo-fp16"] && !models["melo-fp32"]) {
          tLog("Downloading TTS models...");
          await tts.downloadAndExtractModels();
        }
        // Use FP32 (RTF ~0.9)
        const availableTtsModel = options?.ttsModel || "melo-fp32";
        tLog(`Loading TTS model: ${availableTtsModel}`);
        await tts.initializeModel(availableTtsModel);
        tLog(`TTS initialized with: ${tts.getCurrentModel()?.id || 'unknown'}`);
      } else {
        tLog(`TTS already initialized with: ${currentModel?.id}`);
      }
      
      tLog("All models initialized!");
      return true;
    } catch (err) {
      const errorMsg = `Failed to initialize models: ${err}`;
      console.error(errorMsg);
      setError(errorMsg);
      return false;
    }
  }, [whisper, llama, tts]);

  // Extract phrases from accumulated text for faster TTS
  // Splits on: commas, semicolons, colons, periods, exclamations, questions
  // This creates smaller chunks (~3-8 words) for faster time-to-first-audio
  const extractSentences = useCallback((text: string): { sentences: string[]; remainder: string } => {
    const phrases: string[] = [];
    let remainder = text;
    const minLength = mergedConfig.minSentenceLength || 6;
    
    // First split by phrase boundaries (punctuation)
    const parts = text.split(PHRASE_SPLIT_REGEX);
    
    if (parts.length > 1) {
      // All but the last part are complete phrases
      for (let i = 0; i < parts.length - 1; i++) {
        let phrase = parts[i].trim();
        
        // Further split on conjunctions for even smaller chunks
        const subParts = phrase.split(CONJUNCTION_SPLIT_REGEX);
        for (const subPart of subParts) {
          const trimmed = subPart.trim();
          if (trimmed.length >= minLength) {
            phrases.push(trimmed);
          }
        }
      }
      remainder = parts[parts.length - 1];
    }
    
    // Also check if remainder has a conjunction we can split on
    // but only if there's already content before it
    if (remainder.length > 30) {
      const conjMatch = remainder.match(CONJUNCTION_SPLIT_REGEX);
      if (conjMatch && conjMatch.index && conjMatch.index > minLength) {
        const beforeConj = remainder.substring(0, conjMatch.index).trim();
        if (beforeConj.length >= minLength) {
          phrases.push(beforeConj);
          remainder = remainder.substring(conjMatch.index).trim();
        }
      }
    }
    
    tLog(`📊 Extracted ${phrases.length} phrases, remainder: "${remainder.substring(0, 30)}..."`);
    
    return { sentences: phrases, remainder };
  }, [mergedConfig.minSentenceLength]);

  // Clean text for TTS - remove non-English characters and normalize
  const cleanTextForTTS = useCallback((text: string): string => {
    // Remove non-ASCII characters (keeps English, numbers, punctuation)
    let cleaned = text.replace(/[^\x00-\x7F]/g, ' ');
    // Remove extra whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    // Remove any remaining control characters
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, '');
    return cleaned;
  }, []);

  // Queue a phrase for TTS
  const queueSentenceForTTS = useCallback((sentence: string) => {
    // Clean the text first
    const cleanedText = cleanTextForTTS(sentence);
    
    // Skip if too short or empty after cleaning
    if (cleanedText.length < 3) {
      tLog(`⏭️ Skipping too short phrase: "${sentence}"`);
      return null;
    }
    
    const id = `tts-${Date.now()}-${queueIdCounterRef.current++}`;
    
    const newItem: TTSQueueItem = {
      id,
      text: cleanedText,
      status: "pending",
    };
    
    tLog(`📝 Queuing phrase for TTS: "${cleanedText.substring(0, 50)}${cleanedText.length > 50 ? '...' : ''}"`);
    
    setTtsQueue(prev => [...prev, newItem]);
    return id;
  }, [cleanTextForTTS]);

  // Synthesize a queued sentence
  const synthesizeSentence = useCallback(async (item: TTSQueueItem): Promise<TTSQueueItem | null> => {
    if (synthesisAbortRef.current) return null;
    
    try {
      // Update status
      setTtsQueue(prev => prev.map(i => 
        i.id === item.id ? { ...i, status: "synthesizing" } : i
      ));
      
      // Debug: Log current TTS model
      const currentTTSModel = tts.getCurrentModel();
      tLog(`🔊 Synthesizing with model: ${currentTTSModel?.label || 'UNKNOWN'} (${currentTTSModel?.id || 'no-id'})`);
      tLog(`🔊 Text: "${item.text.substring(0, 30)}..."`);
      tLog(`🔊 TTS Ready: ${tts.isReady()}`);
      
      // Get TTS directory
      const directory = await tts.getModelDirectory();
      const outputPath = new File(directory, `voice_${item.id}.wav`).uri;
      
      // Synthesize
      const startTime = Date.now();
      await tts.synthesizeToFile(item.text, outputPath, {
        lengthScale: mergedConfig.ttsSpeed,
        noiseScale: mergedConfig.ttsNaturalness,
      });
      const duration = (Date.now() - startTime) / 1000;
      
      tLog(`✅ Synthesized in ${duration.toFixed(2)}s: "${item.text.substring(0, 30)}..."`);
      
      // Update queue with audio path
      const updatedItem: TTSQueueItem = {
        ...item,
        status: "ready",
        audioPath: outputPath,
        audioDuration: duration,
      };
      
      setTtsQueue(prev => prev.map(i => 
        i.id === item.id ? updatedItem : i
      ));
      
      return updatedItem;
    } catch (err) {
      console.error(`TTS synthesis failed for "${item.text}":`, err);
      setTtsQueue(prev => prev.map(i => 
        i.id === item.id ? { ...i, status: "done" } : i
      ));
      return null;
    }
  }, [tts, mergedConfig]);

  // Play audio for a TTS item
  const playTTSItem = useCallback(async (item: TTSQueueItem) => {
    if (!item.audioPath) return;
    
    try {
      setTtsQueue(prev => prev.map(i => 
        i.id === item.id ? { ...i, status: "playing" } : i
      ));
      setCurrentPlayingId(item.id);
      
      tLog(`▶️ Playing: "${item.text.substring(0, 30)}..."`);
      
      // Create audio player
      const player = new AudioModule.AudioPlayer({ uri: item.audioPath }, 100, false);
      audioPlayersRef.current.set(item.id, player);
      
      // Play and wait for completion
      await new Promise<void>((resolve) => {
        // Set up a polling mechanism to detect when playback ends
        player.play();
        
        const checkInterval = setInterval(() => {
          // Check if player is still playing
          // AudioPlayer doesn't have a built-in completion callback, so we poll
          if (!player.playing) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
        
        // Also set a timeout based on estimated duration
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, (item.audioDuration || 5) * 1000 + 500); // Add 500ms buffer
      });
      
      // Cleanup
      player.remove();
      audioPlayersRef.current.delete(item.id);
      
      setTtsQueue(prev => prev.map(i => 
        i.id === item.id ? { ...i, status: "done" } : i
      ));
      setCurrentPlayingId(null);
      
      // Delete the audio file to save space
      try {
        const file = new File(item.audioPath);
        if (file.exists) file.delete();
      } catch (e) {
        console.warn("Failed to cleanup audio file:", e);
      }
      
    } catch (err) {
      console.error("Audio playback error:", err);
      setCurrentPlayingId(null);
    }
  }, []);

  // Process TTS queue - synthesize and play in order
  const processTTSQueue = useCallback(async () => {
    // This function is called whenever the queue changes
    // It processes pending items and plays ready items in order
  }, []);

  // Effect to process TTS queue
  useEffect(() => {
    const processQueue = async () => {
      // Find pending items to synthesize (up to maxConcurrentSynthesis)
      const pendingItems = ttsQueue.filter(item => item.status === "pending");
      const synthesizingCount = ttsQueue.filter(item => item.status === "synthesizing").length;
      const playingCount = ttsQueue.filter(item => item.status === "playing").length;
      const readyCount = ttsQueue.filter(item => item.status === "ready").length;
      const availableSlots = (mergedConfig.maxConcurrentSynthesis || 1) - synthesizingCount;
      
      // Calculate total ready audio duration
      const readyItems = ttsQueue.filter(item => item.status === "ready");
      const totalReadyDuration = readyItems.reduce((sum, item) => sum + (item.audioDuration || 0), 0);
      const hasEnoughBuffer = totalReadyDuration >= MIN_AUDIO_BUFFER_SECONDS;
      const isLLMDone = pipelineState !== "thinking"; // LLM finished generating
      
      // Debug: Log queue state
      if (ttsQueue.length > 0) {
        tLog(`🎯 Queue: pending=${pendingItems.length}, synthesizing=${synthesizingCount}, ready=${readyCount} (${totalReadyDuration.toFixed(1)}s), playing=${playingCount}`);
      }
      
      // Start synthesis for pending items (can synthesize while playing!)
      for (let i = 0; i < Math.min(pendingItems.length, availableSlots); i++) {
        tLog(`🚀 Starting synthesis for chunk while ${playingCount > 0 ? 'PLAYING' : 'idle'}`);
        synthesizeSentence(pendingItems[i]);
      }
      
      // Play ready items in order (if nothing is currently playing)
      // Only start if we have enough buffer OR if LLM is done and no more pending
      if (!currentPlayingId) {
        const readyItem = ttsQueue.find(item => item.status === "ready");
        if (readyItem) {
          const shouldStartPlaying = hasEnoughBuffer || 
                                     (isLLMDone && pendingItems.length === 0 && synthesizingCount === 0);
          
          if (shouldStartPlaying) {
            tLog(`▶️ Starting playback (buffer: ${totalReadyDuration.toFixed(1)}s, llmDone: ${isLLMDone})`);
            playTTSItem(readyItem);
          } else {
            tLog(`⏳ Waiting for ${MIN_AUDIO_BUFFER_SECONDS}s buffer (current: ${totalReadyDuration.toFixed(1)}s)`);
          }
        }
      }
      
      // Check if all items are done
      const allDone = ttsQueue.length > 0 && ttsQueue.every(item => item.status === "done");
      if (allDone && pipelineState === "speaking") {
        setPipelineState("idle");
        setTtsQueue([]);
      }
    };
    
    processQueue();
  }, [ttsQueue, currentPlayingId, pipelineState, mergedConfig.maxConcurrentSynthesis, synthesizeSentence, playTTSItem]);

  // Handle LLM token callback - detect sentences and queue for TTS
  const handleLLMToken = useCallback((token: string) => {
    // Accumulate the token
    accumulatedTextRef.current += token;
    setLlmResponse(accumulatedTextRef.current);
    
    // Check for complete sentences
    const { sentences, remainder } = extractSentences(accumulatedTextRef.current);
    
    // Queue new sentences for TTS
    for (const sentence of sentences) {
      if (!processedSentencesRef.current.has(sentence)) {
        processedSentencesRef.current.add(sentence);
        queueSentenceForTTS(sentence);
      }
    }
    
    // Update accumulated text to just the remainder
    accumulatedTextRef.current = remainder;
  }, [extractSentences, queueSentenceForTTS]);

  // Handle completion of LLM response
  const handleLLMComplete = useCallback(() => {
    // Queue any remaining text
    const remainingText = accumulatedTextRef.current.trim();
    if (remainingText.length > 0 && !processedSentencesRef.current.has(remainingText)) {
      processedSentencesRef.current.add(remainingText);
      queueSentenceForTTS(remainingText);
    }
    
    // Clear accumulators
    accumulatedTextRef.current = "";
  }, [queueSentenceForTTS]);

  // Start listening for voice input
  const startListening = useCallback(async () => {
    if (!whisper.whisperContext) {
      setError("Whisper not initialized");
      return false;
    }
    
    try {
      setError(null);
      setPipelineState("listening");
      setCurrentTranscription("");
      setFinalTranscription("");
      setLlmResponse("");
      setTtsQueue([]);
      synthesisAbortRef.current = false;
      accumulatedTextRef.current = "";
      processedSentencesRef.current.clear();
      
      tLog("🎤 Starting voice input...");
      
      const { stop, subscribe } = await whisper.whisperContext.transcribeRealtime({
        language: "en",
        realtimeAudioSec: 60,
        realtimeAudioSliceSec: 5,
        realtimeAudioMinSec: 1,
        audioSessionOnStartIos: {
          category: "PlayAndRecord" as any,
          options: ["MixWithOthers" as any],
          mode: "Default" as any,
        },
        audioSessionOnStopIos: "restore" as any,
      });
      
      currentTranscriberRef.current = { stop };
      
      subscribe((event: any) => {
        const { isCapturing, data } = event;
        
        if (data?.result) {
          const transcript = data.result.trim();
          setCurrentTranscription(transcript);
          tLog(`📝 Transcription: ${transcript}`);
        }
      });
      
      return true;
    } catch (err) {
      const errorMsg = `Failed to start listening: ${err}`;
      console.error(errorMsg);
      setError(errorMsg);
      setPipelineState("error");
      return false;
    }
  }, [whisper.whisperContext]);

  // Stop listening and process the transcription
  const stopListeningAndProcess = useCallback(async () => {
    try {
      // Stop transcription
      if (currentTranscriberRef.current?.stop) {
        await currentTranscriberRef.current.stop();
        currentTranscriberRef.current = null;
      }
      
      const finalText = currentTranscription.trim();
      setFinalTranscription(finalText);
      
      if (!finalText) {
        tLog("No transcription captured");
        setPipelineState("idle");
        return;
      }
      
      tLog(`🎯 Final transcription: "${finalText}"`);
      
      // Transition to thinking state
      setPipelineState("thinking");
      
      // Add user message to history
      const userMessage: ChatMessage = {
        role: "user",
        content: finalText,
      };
      
      const newHistory = [...conversationHistory, userMessage];
      setConversationHistory(newHistory);
      
      // Build messages for LLM
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: mergedConfig.systemPrompt || DEFAULT_CONFIG.systemPrompt!,
        },
        ...newHistory,
      ];
      
      // Start LLM completion with streaming
      tLog("🤖 Starting LLM completion...");
      setPipelineState("speaking"); // Transition to speaking as we'll start TTS soon
      
      const response = await llama.completion(messages, handleLLMToken);
      
      // Handle completion
      handleLLMComplete();
      
      // Add assistant response to history
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response,
      };
      setConversationHistory(prev => [...prev, assistantMessage]);
      
      tLog("✅ LLM response complete");
      
    } catch (err) {
      const errorMsg = `Processing failed: ${err}`;
      console.error(errorMsg);
      setError(errorMsg);
      setPipelineState("error");
    }
  }, [currentTranscription, conversationHistory, llama, mergedConfig.systemPrompt, handleLLMToken, handleLLMComplete]);

  // Send a text message (skip transcription, go directly to LLM)
  const sendTextMessage = useCallback(async (text: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) {
      tLog("Empty text message, ignoring");
      return;
    }
    
    if (pipelineState !== "idle") {
      console.log("Pipeline busy, cannot send text");
      return;
    }
    
    try {
      setError(null);
      setFinalTranscription(trimmedText);
      setLlmResponse("");
      setTtsQueue([]);
      synthesisAbortRef.current = false;
      accumulatedTextRef.current = "";
      processedSentencesRef.current.clear();
      
      console.log(`💬 Text message: "${trimmedText}"`);
      
      // Transition to thinking state
      setPipelineState("thinking");
      
      // Add user message to history
      const userMessage: ChatMessage = {
        role: "user",
        content: trimmedText,
      };
      
      const newHistory = [...conversationHistory, userMessage];
      setConversationHistory(newHistory);
      
      // Build messages for LLM
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: mergedConfig.systemPrompt || DEFAULT_CONFIG.systemPrompt!,
        },
        ...newHistory,
      ];
      
      // Start LLM completion with streaming
      tLog("🤖 Starting LLM completion...");
      setPipelineState("speaking");
      
      const response = await llama.completion(messages, handleLLMToken);
      
      // Handle completion
      handleLLMComplete();
      
      // Add assistant response to history
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response,
      };
      setConversationHistory(prev => [...prev, assistantMessage]);
      
      tLog("✅ LLM response complete");
      
    } catch (err) {
      const errorMsg = `Text processing failed: ${err}`;
      console.error(errorMsg);
      setError(errorMsg);
      setPipelineState("error");
    }
  }, [pipelineState, conversationHistory, llama, mergedConfig.systemPrompt, handleLLMToken, handleLLMComplete]);

  // Cancel current operation
  const cancel = useCallback(async () => {
    synthesisAbortRef.current = true;
    
    // Stop transcription
    if (currentTranscriberRef.current?.stop) {
      try {
        await currentTranscriberRef.current.stop();
      } catch (e) {
        console.warn("Error stopping transcription:", e);
      }
      currentTranscriberRef.current = null;
    }
    
    // Stop all audio
    audioPlayersRef.current.forEach((player, id) => {
      try {
        player.pause();
        player.remove();
      } catch (e) {
        console.warn("Error stopping audio player:", e);
      }
    });
    audioPlayersRef.current.clear();
    
    // Stop TTS
    tts.stopAudio();
    
    // Reset state
    setPipelineState("idle");
    setCurrentTranscription("");
    setLlmResponse("");
    setTtsQueue([]);
    setCurrentPlayingId(null);
    
    console.log("🛑 Pipeline cancelled");
  }, [tts]);

  // Clear conversation history
  const clearHistory = useCallback(() => {
    setConversationHistory([]);
    setFinalTranscription("");
    setLlmResponse("");
    console.log("📜 Conversation history cleared");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancel();
    };
  }, []);

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
    isWhisperLoading: whisper.isInitializingModel || whisper.isDownloading,
    isLlamaLoading: llama.isInitializingModel || llama.isDownloading,
    isTTSLoading: tts.isInitializingModel || tts.isDownloading,
    
    // Actions
    initializeAll,
    startListening,
    stopListeningAndProcess,
    sendTextMessage,
    cancel,
    clearHistory,
    
    // Individual hooks access (for advanced usage)
    whisper,
    llama,
    tts,
  };
}

