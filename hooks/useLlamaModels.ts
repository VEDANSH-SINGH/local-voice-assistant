import { Directory, File, Paths } from "expo-file-system"
import { initLlama, LlamaContext } from "llama.rn"
import { useCallback, useEffect, useRef, useState } from "react"

// Model definitions with expected file sizes for validation
export const LLAMA_MODELS = [
  {
    id: "gemma-3-270m",
    label: "Gemma 3 IT (270M)",
    description: "Instruction-tuned, compact model for chat",
    size: "270M",
    url: "https://huggingface.co/ggml-org/gemma-3-270m-it-GGUF/resolve/main/gemma-3-270m-it-Q8_0.gguf?download=true",
    expectedSizeBytes: 290000000, // ~290MB - minimum expected size for validation
  },
  {
    id: "gemma-3-1b",
    label: "Gemma 3 (1B)",
    description: "Larger model with better quality responses",
    size: "1B",
    url: "https://huggingface.co/ggml-org/gemma-3-1b-GGUF/resolve/main/gemma-3-1b-Q4_K_M.gguf?download=true",
    expectedSizeBytes: 750000000, // ~750MB
  },
  {
    id: "gemma-2b-it",
    label: "Gemma 2B IT Q8 (Finetuned)",
    description: "Fine-tuned instruction model with 8-bit quantization",
    size: "2B",
    url: "https://huggingface.co/vedanshsingh17/gemma-finetune-2b-it-gguf-v3/resolve/main/gemma-2b-it.Q8_0.gguf",
    expectedSizeBytes: 2600000000, // ~2.6GB Q8_0 quantization
  },
  {
    id: "phi-3-mini",
    label: "Phi-3 Mini 4K Q4",
    description: "Microsoft's efficient 3.8B model, great quality",
    size: "3.8B",
    url: "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf?download=true",
    expectedSizeBytes: 2300000000, // ~2.3GB Q4 quantization
  },
  {
    id: "qwen2-0.5b",
    label: "Qwen2 (0.5B)",
    description: "Fast, lightweight multilingual model",
    size: "0.5B",
    url: "https://huggingface.co/Qwen/Qwen2-0.5B-Instruct-GGUF/resolve/main/qwen2-0_5b-instruct-q4_k_m.gguf?download=true",
    expectedSizeBytes: 350000000, // ~350MB
  },
]

// Chat message type
export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

// Model file info
interface ModelFileInfo {
  path: string
  size: number
  isValid?: boolean
}

// Directory name for llama models
const LLAMA_DIRECTORY_NAME = "llama-models"

export function useLlamaModels() {
  // Context reference
  const contextRef = useRef<LlamaContext | null>(null)

  // State
  const [isInitializingModel, setIsInitializingModel] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [currentModelId, setCurrentModelId] = useState<string | null>(null)
  const [modelFiles, setModelFiles] = useState<Record<string, ModelFileInfo>>(
    {}
  )
  const [llamaError, setLlamaError] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({})

  // Get model directory
  const getModelDirectory = useCallback(async (): Promise<Directory> => {
    const directory = new Directory(Paths.document, LLAMA_DIRECTORY_NAME)
    if (!directory.exists) {
      directory.create({ intermediates: true })
    }
    return directory
  }, [])

  // Validate model file (check if it's complete/not corrupted)
  const validateModelFile = useCallback(
    (modelId: string, fileSize: number): boolean => {
      const model = LLAMA_MODELS.find((m) => m.id === modelId)
      if (!model) return false

      // Check if file size is at least 80% of expected (to account for compression variations)
      const minExpectedSize = model.expectedSizeBytes * 0.8
      const isValid = fileSize >= minExpectedSize

      if (!isValid) {
        console.warn(
          `Model ${modelId} appears corrupted: ${fileSize} bytes (expected ~${model.expectedSizeBytes})`
        )
      }

      return isValid
    },
    []
  )

  // Refresh model files list
  const refreshModelFiles = useCallback(async () => {
    try {
      const modelDir = await getModelDirectory()
      const files: Record<string, ModelFileInfo> = {}

      for (const model of LLAMA_MODELS) {
        const modelFile = new File(modelDir, `${model.id}.gguf`)
        if (modelFile.exists) {
          const size = modelFile.size ?? 0
          const isValid = validateModelFile(model.id, size)
          files[model.id] = {
            path: modelFile.uri,
            size: size,
            isValid: isValid,
          }
        }
      }

      setModelFiles(files)
      return files
    } catch (error) {
      console.error("Error refreshing model files:", error)
      return {}
    }
  }, [getModelDirectory, validateModelFile])

  // Download a model (with optional force re-download)
  const downloadModel = useCallback(
    async (
      modelId: string,
      options?: { force?: boolean }
    ): Promise<boolean> => {
      const model = LLAMA_MODELS.find((m) => m.id === modelId)
      if (!model) {
        console.error("Model not found:", modelId)
        return false
      }

      try {
        setIsDownloading(true)
        setDownloadProgress({ [modelId]: 0 })
        setLlamaError(null)

        const modelDir = await getModelDirectory()
        const modelFile = new File(modelDir, `${modelId}.gguf`)

        // Delete existing file if force re-download
        if (options?.force && modelFile.exists) {
          console.log("Force re-download: deleting existing file...")
          modelFile.delete()
        }

        // Skip if file already exists and we're not forcing
        if (!options?.force && modelFile.exists) {
          const size = modelFile.size ?? 0
          if (validateModelFile(modelId, size)) {
            console.log("Model already exists and is valid, skipping download")
            await refreshModelFiles()
            return true
          } else {
            console.log("Existing model file is invalid, re-downloading...")
            modelFile.delete()
          }
        }

        console.log("Downloading model from:", model.url)
        console.log("Target path:", modelFile.uri)

        await File.downloadFileAsync(model.url, modelFile, {
          onProgress: (event) => {
            const progress =
              event.totalBytesWritten / event.totalBytesExpectedToWrite
            setDownloadProgress({ [modelId]: progress })
            console.log(`Download progress: ${(progress * 100).toFixed(1)}%`)
          },
        })

        console.log("Model download complete")

        // Validate the downloaded file
        const downloadedSize = modelFile.size ?? 0
        if (!validateModelFile(modelId, downloadedSize)) {
          setLlamaError(
            "Downloaded file appears to be corrupted. Please try again."
          )
          modelFile.delete()
          return false
        }

        await refreshModelFiles()
        return true
      } catch (error) {
        console.error("Download error:", error)
        setLlamaError(`Download failed: ${error}`)
        return false
      } finally {
        setIsDownloading(false)
      }
    },
    [getModelDirectory, refreshModelFiles, validateModelFile]
  )

  // Initialize a model
  const initializeLlamaModel = useCallback(
    async (
      modelId: string,
      options?: { forceRedownload?: boolean }
    ): Promise<boolean> => {
      const model = LLAMA_MODELS.find((m) => m.id === modelId)
      if (!model) {
        console.error("Model not found:", modelId)
        return false
      }

      try {
        setIsInitializingModel(true)
        setLlamaError(null)

        // Check if model file exists and is valid
        const currentFiles = await refreshModelFiles()
        const existingFile = currentFiles[modelId]

        const needsDownload =
          !existingFile || !existingFile.isValid || options?.forceRedownload

        if (needsDownload) {
          if (existingFile && !existingFile.isValid) {
            console.log(
              "Model file exists but is invalid/corrupted, re-downloading..."
            )
          } else if (options?.forceRedownload) {
            console.log("Force re-download requested...")
          } else {
            console.log("Model not found locally, downloading...")
          }

          const downloaded = await downloadModel(modelId, {
            force: options?.forceRedownload || !existingFile?.isValid,
          })
          if (!downloaded) {
            return false
          }
        }

        // Get model path
        const modelDir = await getModelDirectory()
        const modelFile = new File(modelDir, `${modelId}.gguf`)

        if (!modelFile.exists) {
          setLlamaError("Model file not found after download")
          return false
        }

        console.log("Initializing Llama model from:", modelFile.uri)

        // Release existing context if any
        if (contextRef.current) {
          try {
            await contextRef.current.release()
          } catch (e) {
            console.warn("Error releasing previous context:", e)
          }
        }

        // Initialize new context with GPU acceleration
        console.log("Loading model with initLlama:", {
          model: modelFile.uri,
          modelId,
          fileSize: modelFile.size,
        })
        const context = await initLlama({
          model: modelFile.uri,
          n_ctx: 2048,
          n_batch: 512,
          n_threads: 4,
          use_mlock: true,
          use_mmap: true,
          // Enable GPU acceleration (Metal on iOS, Vulkan on Android)
          // Set to a high number to offload as many layers as possible to GPU
          n_gpu_layers: 99,
        })

        contextRef.current = context
        setCurrentModelId(modelId)

        console.log("Llama model initialized successfully")
        return true
      } catch (error: any) {
        // Log detailed error information
        console.error("=== MODEL LOAD FAILURE ===")
        console.error("Error message:", error?.message || String(error))
        console.error("Error name:", error?.name)
        console.error("Error code:", error?.code)
        console.error(
          "Full error object:",
          JSON.stringify(error, Object.getOwnPropertyNames(error || {}), 2)
        )
        console.error("Stack trace:", error?.stack)
        console.error("Model ID:", modelId)
        console.error("===========================")

        // Common failure reasons
        let errorMessage = `Failed to initialize model: ${
          error?.message || error
        }`
        if (
          error?.message?.includes("memory") ||
          error?.message?.includes("Memory")
        ) {
          errorMessage += " (Likely out of memory - try a smaller model)"
        } else if (
          error?.message?.includes("format") ||
          error?.message?.includes("invalid")
        ) {
          errorMessage += " (Model format may be incompatible)"
        }

        setLlamaError(errorMessage)
        return false
      } finally {
        setIsInitializingModel(false)
      }
    },
    [downloadModel, getModelDirectory, refreshModelFiles]
  )

  // Release context
  const releaseContext = useCallback(async () => {
    try {
      if (contextRef.current) {
        await contextRef.current.release()
        contextRef.current = null
      }
      setCurrentModelId(null)
    } catch (error) {
      console.error("Error releasing context:", error)
    }
  }, [])

  // Delete a model
  const deleteModel = useCallback(
    async (modelId: string): Promise<boolean> => {
      try {
        // Release context if this is the current model
        if (currentModelId === modelId) {
          await releaseContext()
        }

        const modelDir = await getModelDirectory()
        const modelFile = new File(modelDir, `${modelId}.gguf`)

        if (modelFile.exists) {
          modelFile.delete()
          console.log("Model deleted:", modelId)
        }

        await refreshModelFiles()
        return true
      } catch (error) {
        console.error("Error deleting model:", error)
        return false
      }
    },
    [currentModelId, getModelDirectory, refreshModelFiles, releaseContext]
  )

  // Format chat messages for the model
  const formatMessages = useCallback((messages: ChatMessage[]): string => {
    let prompt = ""

    for (const message of messages) {
      switch (message.role) {
        case "system":
          prompt += `<start_of_turn>user\nSystem: ${message.content}<end_of_turn>\n`
          break
        case "user":
          prompt += `<start_of_turn>user\n${message.content}<end_of_turn>\n`
          break
        case "assistant":
          prompt += `<start_of_turn>model\n${message.content}<end_of_turn>\n`
          break
      }
    }

    // Add the start of the assistant response
    prompt += "<start_of_turn>model\n"

    return prompt
  }, [])

  // Run completion
  const completion = useCallback(
    async (
      messages: ChatMessage[],
      onToken?: (token: string) => void
    ): Promise<string> => {
      if (!contextRef.current) {
        throw new Error("Llama context not initialized")
      }

      setIsGenerating(true)

      try {
        const prompt = formatMessages(messages)
        console.log("Running completion with prompt length:", prompt.length)

        let fullResponse = ""
        const stopTokens = ["<end_of_turn>", "<start_of_turn>", "<eos>"]

        const result = await contextRef.current.completion(
          {
            prompt,
            n_predict: 512,
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            repeat_penalty: 1.1,
            stop: stopTokens,
          },
          (data) => {
            const token = data.token

            // Check if we've hit a stop token
            for (const stopToken of stopTokens) {
              if (fullResponse.includes(stopToken)) {
                return true // Signal to stop
              }
            }

            fullResponse += token
            if (onToken) {
              onToken(token)
            }
            return false
          }
        )

        // Log full result for debugging
        console.log("Raw completion result:", JSON.stringify(result, null, 2))

        // Calculate metrics
        const tokensGenerated =
          result.tokens_predicted || result.tokens_evaluated || 0
        const totalTimeMs =
          result.timings?.predicted_ms ||
          result.timings?.total_ms ||
          result.total_time ||
          0
        const tokensPerSecond =
          totalTimeMs > 0
            ? (tokensGenerated / (totalTimeMs / 1000)).toFixed(2)
            : "N/A"

        console.log("=== LLM Performance ===")
        console.log(`Tokens generated: ${tokensGenerated}`)
        console.log(`Time: ${totalTimeMs.toFixed(0)}ms`)
        console.log(`Speed: ${tokensPerSecond} tokens/sec`)
        if (result.timings) {
          console.log("Detailed timings:", result.timings)
        }
        console.log("======================")

        // Clean up response - remove any stop tokens that might have slipped through
        let cleanedResponse = fullResponse
        for (const stopToken of stopTokens) {
          cleanedResponse = cleanedResponse.split(stopToken)[0]
        }

        return cleanedResponse.trim()
      } finally {
        setIsGenerating(false)
      }
    },
    [formatMessages]
  )

  // Get current model info
  const getCurrentModel = useCallback(() => {
    return LLAMA_MODELS.find((m) => m.id === currentModelId) || null
  }, [currentModelId])

  // Get model by ID
  const getModelById = useCallback((modelId: string) => {
    return LLAMA_MODELS.find((m) => m.id === modelId) || null
  }, [])

  // Get download progress
  const getDownloadProgress = useCallback(
    (modelId: string) => {
      return downloadProgress[modelId] ?? null
    },
    [downloadProgress]
  )

  // Get llama context (for advanced usage)
  const getLlamaContext = useCallback(() => {
    return contextRef.current
  }, [])

  // Check if ready
  const isReady = useCallback(() => {
    return contextRef.current !== null
  }, [])

  // Check if model is valid/complete
  const isModelValid = useCallback(
    (modelId: string) => {
      return modelFiles[modelId]?.isValid ?? false
    },
    [modelFiles]
  )

  // Load existing models on mount
  useEffect(() => {
    refreshModelFiles()
  }, [])

  return {
    // State
    llamaContext: contextRef.current,
    isInitializingModel,
    isDownloading,
    isGenerating,
    currentModelId,
    modelFiles,
    llamaError,
    downloadProgress,

    // Actions
    initializeLlamaModel,
    downloadModel,
    releaseContext,
    deleteModel,
    completion,

    // Helpers
    getCurrentModel,
    getModelById,
    getDownloadProgress,
    getLlamaContext,
    isReady,
    isModelValid,
    refreshModelFiles,
    getModelDirectory,

    // Constants
    availableModels: LLAMA_MODELS,
  }
}

// Export model type for external use
export type { ModelFileInfo }
