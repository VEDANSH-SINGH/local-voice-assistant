/**
 * MeloTTS ONNX model integration for React Native
 *
 * Model files required in document directory 'melo-tts-models/':
 * - model_int8.onnx (or model.onnx)
 * - tokens.txt
 * - lexicon.txt
 * - tts_config.json
 */
import AudioModule from "expo-audio/build/AudioModule"
import { Directory, File, Paths } from "expo-file-system"
import {
  EncodingType,
  cacheDirectory,
  createDownloadResumable,
  writeAsStringAsync,
  type DownloadProgressData,
  type FileSystemDownloadResult,
} from "expo-file-system/legacy"
import { useCallback, useEffect, useRef, useState } from "react"
import { Platform } from "react-native"
import { unzip } from "react-native-zip-archive"

// Import ONNX runtime directly as per docs
import { InferenceSession, Tensor } from "onnxruntime-react-native"

// S3 URLs for MeloTTS model files
// Default MeloTTS variant
export const MELO_TTS_MODELS_URL =
  "https://test-transcription-service-nxtwave.s3.ap-south-1.amazonaws.com/melo-tts-models.zip"
// Custom model variant
export const MELO_TTS_CUSTOM_MODEL_URL =
  "https://test-transcription-service-nxtwave.s3.ap-south-1.amazonaws.com/default_export.zip"
// BERT-enhanced model variant (higher quality prosody)
export const MELO_TTS_BERT_MODEL_URL =
  "https://test-transcription-service-nxtwave.s3.ap-south-1.amazonaws.com/melo-tts-models-with-bert.zip"

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

/**
 * TextChunker - Split text into chunks, trying to keep sentences intact.
 * Matches MeloTTS split_utils.py behavior.
 */
class TextChunker {
  private desiredLength: number
  private maxLength: number

  constructor(desiredLength = 256, maxLength = 512) {
    this.desiredLength = desiredLength
    this.maxLength = maxLength
  }

  /**
   * Split text into chunks, trying to keep sentences intact.
   */
  splitText(text: string): string[] {
    // Normalize text
    text = text.replace(/\n\n+/g, "\n")
    text = text.replace(/\s+/g, " ")
    text = text.replace(/[""]/g, '"')
    text = text.replace(/([,.?!])/g, "$1 ")
    text = text.replace(/\s+/g, " ").trim()

    const chunks: string[] = []
    let current = ""
    let inQuote = false
    let splitPositions: number[] = []

    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      current += c

      if (c === '"') {
        inQuote = !inQuote
      }

      // Check for sentence boundaries
      if (
        !inQuote &&
        (c === "!" ||
          c === "?" ||
          c === "\n" ||
          (c === "." &&
            (text[i + 1] === "\n" ||
              text[i + 1] === " " ||
              i === text.length - 1)) ||
          (c === "," && (text[i + 1] === "\n" || text[i + 1] === " ")))
      ) {
        splitPositions.push(current.length)

        if (current.length >= this.desiredLength) {
          chunks.push(current.trim())
          current = ""
          splitPositions = []
        }
      }

      // Force split if too long
      if (current.length >= this.maxLength) {
        if (
          splitPositions.length > 0 &&
          current.length > this.desiredLength / 2
        ) {
          // Backtrack to last sentence boundary
          const splitAt = splitPositions[splitPositions.length - 1]
          const overflow = current.slice(splitAt)
          current = current.slice(0, splitAt)
          chunks.push(current.trim())
          current = overflow
          splitPositions = []
        } else {
          // No good split point, force split at word boundary
          const lastSpace = current.lastIndexOf(" ")
          if (lastSpace > this.desiredLength / 2) {
            const overflow = current.slice(lastSpace + 1)
            current = current.slice(0, lastSpace)
            chunks.push(current.trim())
            current = overflow
          } else {
            chunks.push(current.trim())
            current = ""
          }
          splitPositions = []
        }
      }
    }

    // Add remaining text
    if (current.trim()) {
      chunks.push(current.trim())
    }

    // Merge short sentences (≤2 words)
    return this.mergeShortSentences(chunks)
  }

  private mergeShortSentences(sentences: string[]): string[] {
    const result: string[] = []

    for (const s of sentences) {
      if (
        result.length > 0 &&
        result[result.length - 1].split(" ").length <= 2
      ) {
        result[result.length - 1] += " " + s
      } else {
        result.push(s)
      }
    }

    // Also check last sentence
    if (
      result.length >= 2 &&
      result[result.length - 1].split(" ").length <= 2
    ) {
      result[result.length - 2] += " " + result.pop()
    }

    return result
  }
}

// Global text chunker instance
const textChunker = new TextChunker()

/**
 * Concatenate audio chunks with silence gaps between them.
 * @param audioChunks Array of Float32Array audio chunks
 * @param sampleRate Audio sample rate
 * @param silenceMs Silence duration in milliseconds (default 50ms)
 * @param speed Playback speed factor (affects silence duration)
 */
function concatAudioChunks(
  audioChunks: Float32Array[],
  sampleRate: number,
  silenceMs: number = 50,
  speed: number = 1.0
): Float32Array {
  const silenceSamples = Math.floor((sampleRate * silenceMs) / 1000 / speed)

  let totalLength = 0
  for (const chunk of audioChunks) {
    totalLength += chunk.length + silenceSamples
  }

  const result = new Float32Array(totalLength)
  let offset = 0

  for (const chunk of audioChunks) {
    result.set(chunk, offset)
    offset += chunk.length + silenceSamples // Silence is already zeros
  }

  return result
}

export interface TTSModel {
  id: string
  label: string
  url: string
  filename: string
  expectedSize: number
  quality: string
}

export interface TTSConfig {
  language: string
  lang_id: number
  tone_start: number
  sample_rate: number
  add_blank: boolean
  n_speakers: number
  spk2id: Record<string, number>
  // BERT-specific fields (optional, present when requires_bert is true)
  requires_bert?: boolean
  bert_model_id?: string
  bert_hidden_dim?: number
  models?: {
    tts?: string
    bert?: string
    fp32?: string
    fp16?: string
    mixed?: string
    int8?: string
  }
}

interface LexiconEntry {
  phones: string[]
  tones: number[]
}

interface ModelFileInfo {
  path: string
  size: number
}

// Available TTS models - you can add more models here
// INT8 is fastest, FP16 is balanced, FP32 is highest quality but slowest
export const TTS_MODELS: TTSModel[] = [
  {
    id: "melo-int8",
    label: "MeloTTS INT8 (Fastest)",
    url: "", // Set to empty - user will provide local files
    filename: "model_int8.onnx",
    expectedSize: 41000000, // ~41MB
    quality: "Fastest - RTF ~1-2x",
  },
  {
    id: "melo-fp16",
    label: "MeloTTS FP16 (Balanced)",
    url: "", // Set to empty - user will provide local files
    filename: "model_fp16.onnx",
    expectedSize: 82000000, // ~82MB
    quality: "Balanced - RTF ~3-5x",
  },
  {
    id: "melo-mixed",
    label: "MeloTTS Mixed",
    url: "", // Set to empty - user will provide local files
    filename: "model_mixed.onnx",
    expectedSize: 82000000, // ~82MB
    quality: "Mixed precision",
  },
  {
    id: "melo-fp32",
    label: "MeloTTS FP32 (Best Quality)",
    url: "", // Set to empty - user will provide local files
    filename: "model.onnx",
    expectedSize: 162000000, // ~162MB
    quality: "Best quality - RTF ~5-10x",
  },
  // BERT-enhanced model (best prosody quality)
  {
    id: "melo-bert",
    label: "MeloTTS + BERT (Best Prosody)",
    url: "", // Set to empty - user will provide local files
    filename: "model_with_bert.onnx",
    expectedSize: 162000000, // ~162MB (TTS model only)
    quality: "Best prosody - requires BERT",
  },
]

// Simple letter-to-phoneme fallback
const LETTER_TO_PHONE: Record<string, string[]> = {
  a: ["ae"],
  b: ["b"],
  c: ["k"],
  d: ["d"],
  e: ["eh"],
  f: ["f"],
  g: ["g"],
  h: ["hh"],
  i: ["ih"],
  j: ["jh"],
  k: ["k"],
  l: ["l"],
  m: ["m"],
  n: ["n"],
  o: ["ow"],
  p: ["p"],
  q: ["k", "w"],
  r: ["r"],
  s: ["s"],
  t: ["t"],
  u: ["ah"],
  v: ["v"],
  w: ["w"],
  x: ["k", "s"],
  y: ["y"],
  z: ["z"],
  // Common digraphs
  th: ["th"],
  sh: ["sh"],
  ch: ["ch"],
  ph: ["f"],
  wh: ["w"],
  ck: ["k"],
  ng: ["ng"],
}

// Model source types
export type ModelSource = "default" | "custom" | "bert"

export function useMeloTTS() {
  const [modelFiles, setModelFiles] = useState<Record<string, ModelFileInfo>>(
    {}
  )
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({})
  const [downloadSpeed, setDownloadSpeed] = useState<string>("")
  const downloadStartTimeRef = useRef<number>(0)
  const lastBytesRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isInitializingModel, setIsInitializingModel] = useState(false)
  const [isSynthesizing, setIsSynthesizing] = useState(false)
  const [lastInferenceTime, setLastInferenceTime] = useState<number | null>(
    null
  ) // in milliseconds
  const [lastAudioDuration, setLastAudioDuration] = useState<number | null>(
    null
  ) // in seconds
  const [currentModelId, setCurrentModelId] = useState<string | null>(null)
  const [onnxError, setOnnxError] = useState<string | null>(null)

  // Track current model source and which sources are downloaded
  const [currentModelSource, setCurrentModelSource] =
    useState<ModelSource>("default")
  const [downloadedSources, setDownloadedSources] = useState<
    Record<ModelSource, boolean>
  >({
    default: false,
    custom: false,
    bert: false,
  })

  // Model resources
  const sessionRef = useRef<any>(null) // InferenceSession from onnxruntime-react-native
  const bertSessionRef = useRef<any>(null) // BERT ONNX session for BERT-enhanced models
  const [tokens, setTokens] = useState<Record<string, number>>({})
  const [lexicon, setLexicon] = useState<Record<string, LexiconEntry>>({})
  const [bertVocab, setBertVocab] = useState<Record<string, number>>({})
  const [config, setConfig] = useState<TTSConfig | null>(null)

  // Audio player
  const audioPlayerRef = useRef<any>(null)

  // Get directory for a specific model source
  const getModelDirectoryForSource = useCallback(
    async (source: ModelSource) => {
      let documentDirectory: Directory
      try {
        documentDirectory = Paths.document
      } catch (error) {
        throw new Error("Document directory is not available.")
      }

      if (!documentDirectory?.uri) {
        throw new Error("Document directory is not available.")
      }

      const dirName =
        source === "bert"
          ? "melo-tts-models-with-bert"
          : source === "custom"
          ? "melo-tts-custom"
          : "melo-tts-default"
      const directory = new Directory(documentDirectory, dirName)
      try {
        directory.create({ idempotent: true, intermediates: true })
      } catch (error) {
        console.warn(`Failed to ensure ${dirName} directory exists:`, error)
        throw error
      }
      return directory
    },
    []
  )

  // Get current model directory based on active source
  const getModelDirectory = useCallback(async () => {
    return getModelDirectoryForSource(currentModelSource)
  }, [currentModelSource, getModelDirectoryForSource])

  // Check if a model source has been downloaded
  const checkSourceDownloaded = useCallback(
    async (source: ModelSource): Promise<boolean> => {
      try {
        const directory = await getModelDirectoryForSource(source)
        
        // For BERT source, check for model_with_bert.onnx and bert.onnx
        if (source === "bert") {
          const bertFiles = [
            new File(directory, "model_with_bert.onnx"),
            new File(directory, "bert.onnx"),
          ]
          const hasBertModels = bertFiles.every((f) => {
            try {
              return f.info().exists
            } catch {
              return false
            }
          })
          return hasBertModels
        }
        
        // For default/custom sources, check for standard model files
        const modelFiles = [
          new File(directory, "model_int8.onnx"),
          new File(directory, "model_fp16.onnx"),
          new File(directory, "model_mixed.onnx"),
          new File(directory, "model.onnx"),
        ]

        const hasAnyModel = modelFiles.some((f) => {
          try {
            return f.info().exists
          } catch {
            return false
          }
        })

        return hasAnyModel
      } catch {
        return false
      }
    },
    [getModelDirectoryForSource]
  )

  // Refresh downloaded sources state
  const refreshDownloadedSources = useCallback(async () => {
    const defaultDownloaded = await checkSourceDownloaded("default")
    const customDownloaded = await checkSourceDownloaded("custom")
    const bertDownloaded = await checkSourceDownloaded("bert")

    setDownloadedSources({
      default: defaultDownloaded,
      custom: customDownloaded,
      bert: bertDownloaded,
    })

    tLog(
      `Downloaded sources: default=${defaultDownloaded}, custom=${customDownloaded}, bert=${bertDownloaded}`
    )

    return { default: defaultDownloaded, custom: customDownloaded, bert: bertDownloaded }
  }, [checkSourceDownloaded])

  const refreshModelFiles = useCallback(
    async (source?: ModelSource) => {
      try {
        const targetSource = source ?? currentModelSource
        const directory = await getModelDirectoryForSource(targetSource)
        const fileMap: Record<string, ModelFileInfo> = {}

        // For BERT source, only check for BERT-specific model
        if (targetSource === "bert") {
          const bertModelFile = new File(directory, "model_with_bert.onnx")
          try {
            const fileInfo = bertModelFile.info()
            if (fileInfo.exists) {
              fileMap["melo-bert"] = {
                path: bertModelFile.uri,
                size: Number(fileInfo.size) || 0,
              }
              console.log(
                `Found BERT TTS model: model_with_bert.onnx (${fileInfo.size} bytes)`
              )
            }
          } catch (e) {
            // File doesn't exist
          }
          
          // Also check for bert.onnx
          const bertFile = new File(directory, "bert.onnx")
          try {
            const fileInfo = bertFile.info()
            if (fileInfo.exists) {
              console.log(
                `Found BERT feature extractor: bert.onnx (${fileInfo.size} bytes)`
              )
            }
          } catch (e) {
            // File doesn't exist
          }
        } else {
          // For default/custom sources, check standard models
          for (const model of TTS_MODELS) {
            if (model.id === "melo-bert") continue // Skip BERT model for non-bert sources
            const file = new File(directory, model.filename)
            try {
              const fileInfo = file.info()
              if (fileInfo.exists) {
                fileMap[model.id] = {
                  path: file.uri,
                  size: Number(fileInfo.size) || 0,
                }
                console.log(
                  `Found model file: ${model.filename} (${fileInfo.size} bytes)`
                )
              }
            } catch (e) {
              // File doesn't exist
            }
          }
        }

        setModelFiles(fileMap)
        console.log(
          `Refreshed model files for ${targetSource}: ${
            Object.keys(fileMap).length
          } found`
        )
        return fileMap
      } catch (error) {
        console.error("Failed to refresh model files:", error)
        return {}
      }
    },
    [currentModelSource, getModelDirectoryForSource]
  )

  const downloadAndExtractModels = useCallback(
    async (source: ModelSource = "default"): Promise<boolean> => {
      try {
        setIsDownloading(true)
        setDownloadProgress({ models: 0 })
        const modelUrl =
          source === "bert"
            ? MELO_TTS_BERT_MODEL_URL
            : source === "custom"
            ? MELO_TTS_CUSTOM_MODEL_URL
            : MELO_TTS_MODELS_URL
        tLog(`Starting MeloTTS models download from S3... (${source})`)

        // Get source-specific directory
        const directory = await getModelDirectoryForSource(source)

        // Check if any model file already exists in this source's directory
        const existingModelFiles = [
          new File(directory, "model_int8.onnx"),
          new File(directory, "model_fp16.onnx"),
          new File(directory, "model_mixed.onnx"),
          new File(directory, "model.onnx"),
        ]

        // Check if models already exist
        try {
          const hasAnyModel = existingModelFiles.some((f) => {
            try {
              return f.info().exists
            } catch {
              return false
            }
          })
          if (hasAnyModel) {
            tLog(
              `MeloTTS ${source} model already downloaded, switching to it...`
            )
            setCurrentModelSource(source)
            await refreshModelFiles(source)
            await refreshDownloadedSources()
            setDownloadProgress({ models: 1 })
            return true
          }
        } catch (e) {
          // Files don't exist, proceed with download
        }

        // List what's in the directory for debugging
        console.log("Model directory contents before download:")
        try {
          const contents = directory.list()
          contents.forEach((item) => console.log(`  - ${item}`))
        } catch (e) {
          console.log("  (empty or error listing)")
        }

        // Download zip to cache directory
        const zipPath = `${cacheDirectory}melo-tts-models.zip`
        console.log("Downloading zip to:", zipPath)

        // Reset speed tracking
        downloadStartTimeRef.current = Date.now()
        lastBytesRef.current = 0
        lastTimeRef.current = Date.now()
        setDownloadSpeed("")

        const downloadResumable = createDownloadResumable(
          modelUrl,
          zipPath,
          {},
          (progressData: DownloadProgressData) => {
            const { totalBytesWritten, totalBytesExpectedToWrite } =
              progressData
            const fraction =
              totalBytesExpectedToWrite > 0
                ? totalBytesWritten / totalBytesExpectedToWrite
                : 0
            setDownloadProgress({ models: fraction * 0.8 }) // 80% for download

            // Calculate speed
            const now = Date.now()
            const timeDiff = (now - lastTimeRef.current) / 1000 // seconds
            if (timeDiff >= 0.5) {
              // Update speed every 0.5 seconds
              const bytesDiff = totalBytesWritten - lastBytesRef.current
              const speed = bytesDiff / timeDiff // bytes per second

              // Format speed
              let speedStr = ""
              if (speed >= 1024 * 1024) {
                speedStr = `${(speed / (1024 * 1024)).toFixed(1)} MB/s`
              } else if (speed >= 1024) {
                speedStr = `${(speed / 1024).toFixed(1)} KB/s`
              } else {
                speedStr = `${speed.toFixed(0)} B/s`
              }
              setDownloadSpeed(speedStr)

              lastBytesRef.current = totalBytesWritten
              lastTimeRef.current = now
            }

            console.log(`Download progress: ${(fraction * 100).toFixed(1)}%`)
          }
        )

        const downloadResult = (await downloadResumable.downloadAsync()) as
          | FileSystemDownloadResult
          | undefined

        if (
          !downloadResult ||
          (downloadResult.status !== 0 &&
            (downloadResult.status < 200 || downloadResult.status >= 300))
        ) {
          throw new Error(
            `Download failed with status: ${downloadResult?.status}`
          )
        }

        const totalDownloadTime = (
          (Date.now() - downloadStartTimeRef.current) /
          1000
        ).toFixed(1)
        tLog(`Download complete in ${totalDownloadTime}s, extracting...`)
        setDownloadSpeed(`Done in ${totalDownloadTime}s`)
        setDownloadProgress({ models: 0.85 })

        // Extract zip to parent directory
        // Default zip contains 'melo-tts-models' folder
        // Custom zip contains 'default_export' folder
        // We'll extract and then move files to the source-specific directory
        const parentDir = Paths.document.uri
        await unzip(zipPath, parentDir)

        tLog("Extraction complete!")
        setDownloadProgress({ models: 0.9 })
        
        // List what's in the document directory after extraction for debugging
        tLog("Document directory contents after extraction:")
        try {
          const docContents = Paths.document.list()
          docContents.forEach((item) => tLog(`  [doc] ${item}`))
        } catch (e) {
          tLog("  (error listing document directory)")
        }
        
        // Check if files are already in target directory (for BERT case)
        tLog(`Target directory (${source}) contents:`)
        try {
          const targetContents = directory.list()
          targetContents.forEach((item) => tLog(`  [target] ${item}`))
        } catch (e) {
          tLog("  (error listing or empty)")
        }

        // Determine source folder names based on zip contents
        // Note: The order matters - check specific folders first, then fall back to document root
        const possibleSourceFolders = [
          {
            dir: new Directory(Paths.document, "default_export"),
            name: "default_export",
          },
          {
            dir: new Directory(Paths.document, "melo-tts-models"),
            name: "melo-tts-models",
          },
          {
            dir: new Directory(Paths.document, "melo-tts-models-with-bert"),
            name: "melo-tts-models-with-bert",
          },
          // Fallback: files might be extracted directly to document root
          {
            dir: Paths.document,
            name: "document root",
          },
        ]

        // Files to move depend on source type
        const filesToMove = source === "bert" ? [
          "model_with_bert.onnx",
          "bert.onnx",
          "bert_vocab.txt",
          "tokens.txt",
          "lexicon.txt",
          "tts_config.json",
        ] : [
          "model_int8.onnx",
          "model_fp16.onnx",
          "model_mixed.onnx",
          "model.onnx",
          "tokens.txt",
          "lexicon.txt",
          "tts_config.json",
        ]

        // Find which folder the zip extracted to and move files to target directory
        for (const {
          dir: sourceDir,
          name: folderName,
        } of possibleSourceFolders) {
          try {
            if (sourceDir.exists) {
              // Check if source and destination are the same directory
              const isSameDirectory = sourceDir.uri === directory.uri
              
              if (isSameDirectory) {
                tLog(
                  `Found '${folderName}' folder - same as target, files already in place`
                )
                // Files are already in the correct location, just verify they exist
                for (const filename of filesToMove) {
                  try {
                    const file = new File(directory, filename)
                    if (file.info().exists) {
                      tLog(`Verified: ${filename}`)
                    } else {
                      tLog(`Warning: ${filename} not found after extraction`)
                    }
                  } catch (e) {
                    console.warn(`Failed to verify ${filename}:`, e)
                  }
                }
              } else if (folderName === "document root") {
                // Files extracted directly to document root - move them to target directory
                tLog(
                  `Found files in document root, moving to ${source} directory...`
                )
                
                let foundAnyFile = false
                for (const filename of filesToMove) {
                  try {
                    const srcFile = new File(sourceDir, filename)
                    const destFile = new File(directory, filename)

                    if (srcFile.info().exists) {
                      foundAnyFile = true
                      // Delete destination if it exists
                      try {
                        if (destFile.info().exists) {
                          destFile.delete()
                        }
                      } catch (e) {
                        /* ignore */
                      }

                      // Move file
                      srcFile.move(destFile)
                      tLog(`Moved from root: ${filename}`)
                    }
                  } catch (e) {
                    console.warn(`Failed to move ${filename} from root:`, e)
                  }
                }
                
                if (!foundAnyFile) {
                  continue // No files found in document root, try next option
                }
                // Don't delete document root folder!
              } else {
                tLog(
                  `Found '${folderName}' folder, moving files to ${source} directory...`
                )

                for (const filename of filesToMove) {
                  try {
                    const srcFile = new File(sourceDir, filename)
                    const destFile = new File(directory, filename)

                    if (srcFile.info().exists) {
                      // Delete destination if it exists
                      try {
                        if (destFile.info().exists) {
                          destFile.delete()
                        }
                      } catch (e) {
                        /* ignore */
                      }

                      // Move file
                      srcFile.move(destFile)
                      tLog(`Moved: ${filename}`)
                    }
                  } catch (e) {
                    console.warn(`Failed to move ${filename}:`, e)
                  }
                }

                // Clean up the extracted folder
                try {
                  sourceDir.delete()
                  tLog(`Cleaned up '${folderName}' folder`)
                } catch (e) {
                  console.warn(`Failed to delete ${folderName} folder:`, e)
                }
              }

              break // Found and processed the source folder
            }
          } catch (e) {
            // Folder doesn't exist, try next one
          }
        }

        setDownloadProgress({ models: 0.95 })

        // Clean up zip file
        try {
          const zipFile = new File(zipPath)
          if (zipFile.info().exists) {
            zipFile.delete()
            console.log("Cleaned up zip file")
          }
        } catch (e) {
          console.warn("Failed to clean up zip file:", e)
        }

        // List what's in the directory after extraction
        console.log("Model directory contents after extraction:")
        try {
          const contents = directory.list()
          contents.forEach((item) => console.log(`  - ${item}`))
        } catch (e) {
          console.log("  (error listing)")
        }

        setDownloadProgress({ models: 1 })

        // Verify extraction - check for model files based on source type
        let hasAnyModelAfter = false
        
        tLog("Verifying extracted files...")
        
        if (source === "bert") {
          // For BERT, check for both required model files
          const bertModelFile = new File(directory, "model_with_bert.onnx")
          const bertFile = new File(directory, "bert.onnx")
          const bertVocabFile = new File(directory, "bert_vocab.txt")
          
          try {
            const hasTtsModel = bertModelFile.info().exists
            const hasBertModel = bertFile.info().exists
            const hasVocab = bertVocabFile.info().exists
            
            tLog(`  model_with_bert.onnx: ${hasTtsModel ? "✓" : "✗"}`)
            tLog(`  bert.onnx: ${hasBertModel ? "✓" : "✗"}`)
            tLog(`  bert_vocab.txt: ${hasVocab ? "✓" : "✗"}`)
            
            hasAnyModelAfter = hasTtsModel && hasBertModel
          } catch (e) {
            tLog(`  Verification error: ${e}`)
            hasAnyModelAfter = false
          }
        } else {
          const modelFilesAfter = [
            { file: new File(directory, "model_int8.onnx"), name: "model_int8.onnx" },
            { file: new File(directory, "model_fp16.onnx"), name: "model_fp16.onnx" },
            { file: new File(directory, "model_mixed.onnx"), name: "model_mixed.onnx" },
            { file: new File(directory, "model.onnx"), name: "model.onnx" },
          ]

          hasAnyModelAfter = modelFilesAfter.some(({ file, name }) => {
            try {
              const exists = file.info().exists
              if (exists) tLog(`  ${name}: ✓`)
              return exists
            } catch {
              return false
            }
          })
        }

        if (!hasAnyModelAfter) {
          // List directory contents for debugging
          tLog("Directory contents at verification failure:")
          try {
            const contents = directory.list()
            contents.forEach((item) => tLog(`  - ${item}`))
          } catch (e) {
            tLog("  (error listing directory)")
          }
          
          throw new Error(
            `Extraction verification failed - no model file found in ${directory.uri}`
          )
        }

        tLog(`Model files verified successfully for ${source}`)

        // Set current source and refresh states
        setCurrentModelSource(source)
        await refreshModelFiles(source)
        await refreshDownloadedSources()

        return true
      } catch (error) {
        console.error("Failed to download/extract models:", error)
        setOnnxError(`Failed to download models: ${error}`)
        return false
      } finally {
        setIsDownloading(false)
      }
    },
    [getModelDirectoryForSource, refreshModelFiles, refreshDownloadedSources]
  )

  // Switch to a different model source (if already downloaded)
  const switchModelSource = useCallback(
    async (source: ModelSource): Promise<boolean> => {
      const isDownloaded = await checkSourceDownloaded(source)

      if (!isDownloaded) {
        tLog(`${source} model not downloaded yet, downloading...`)
        return downloadAndExtractModels(source)
      }

      tLog(`Switching to ${source} model source...`)
      setCurrentModelSource(source)
      await refreshModelFiles(source)
      return true
    },
    [checkSourceDownloaded, downloadAndExtractModels, refreshModelFiles]
  )

  const loadTokens = useCallback(
    async (tokensPath: string): Promise<Record<string, number>> => {
      const file = new File(tokensPath)
      const content = await file.text()
      const tokenMap: Record<string, number> = {}

      content.split("\n").forEach((line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        const parts = trimmed.split(" ")
        if (parts.length >= 2) {
          const symbol = parts[0]
          const id = parseInt(parts[1], 10)
          if (!isNaN(id)) {
            tokenMap[symbol] = id
          }
        }
      })

      console.log(`Loaded ${Object.keys(tokenMap).length} tokens`)
      return tokenMap
    },
    []
  )

  const loadLexicon = useCallback(
    async (lexiconPath: string): Promise<Record<string, LexiconEntry>> => {
      const file = new File(lexiconPath)
      const content = await file.text()
      const lexiconMap: Record<string, LexiconEntry> = {}

      content.split("\n").forEach((line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        const parts = trimmed.split(" ").filter((p) => p.length > 0)
        if (parts.length >= 2) {
          const word = parts[0]
          const rest = parts.slice(1)
          const mid = Math.floor(rest.length / 2)
          const phones = rest.slice(0, mid)
          const tones = rest.slice(mid).map((t) => parseInt(t, 10))
          lexiconMap[word] = { phones, tones }
        }
      })

      console.log(`Loaded ${Object.keys(lexiconMap).length} lexicon entries`)
      return lexiconMap
    },
    []
  )

  const loadConfig = useCallback(
    async (configPath: string): Promise<TTSConfig> => {
      const file = new File(configPath)
      const content = await file.text()
      const configData = JSON.parse(content) as TTSConfig
      console.log("Loaded TTS config:", configData)
      return configData
    },
    []
  )

  // Load BERT vocabulary file (format: token\ntoken\n... where line number = token ID)
  const loadBertVocab = useCallback(
    async (vocabPath: string): Promise<Record<string, number>> => {
      const file = new File(vocabPath)
      const content = await file.text()
      const vocabMap: Record<string, number> = {}

      content.split("\n").forEach((token, idx) => {
        if (token) {
          vocabMap[token] = idx
        }
      })

      console.log(`Loaded ${Object.keys(vocabMap).length} BERT vocab entries`)
      return vocabMap
    },
    []
  )

  // BERT tokenizer aligned with word2ph structure
  // Takes normalizedWords array (same source as word2ph) to ensure alignment
  const bertTokenize = useCallback(
    (normalizedWords: string[], vocabMap: Record<string, number>) => {
      const tokens: string[] = ["[CLS]"]

      // Process each word from normalizedWords (same as word2ph source)
      // This ensures 1:1 alignment between BERT tokens and word2ph entries
      for (const word of normalizedWords) {
        const lowerWord = word.toLowerCase()

        if (vocabMap[lowerWord] !== undefined) {
          tokens.push(lowerWord)
        } else {
          // WordPiece fallback - but treat as single token for alignment
          // Try to find longest matching prefix
          let found = false
          for (let end = lowerWord.length; end > 0; end--) {
            if (vocabMap[lowerWord.slice(0, end)] !== undefined) {
              tokens.push(lowerWord.slice(0, end))
              found = true
              break
            }
          }
          if (!found) {
            tokens.push("[UNK]")
          }
        }
      }

      tokens.push("[SEP]")

      // Convert to IDs
      const inputIds = tokens.map((t) => vocabMap[t] ?? vocabMap["[UNK]"] ?? 0)
      const attentionMask = new Array(inputIds.length).fill(1)

      return { inputIds, attentionMask, numTokens: tokens.length, tokens }
    },
    []
  )

  // Simple G2P fallback for unknown words (moved up for dependency ordering)
  const simpleG2P = useCallback(
    (
      word: string,
      toneStart: number
    ): { phones: string[]; tones: number[] } => {
      const phones: string[] = []
      const tones: number[] = []
      let i = 0
      const lowerWord = word.toLowerCase()

      while (i < lowerWord.length) {
        // Try 2-letter combinations first
        if (i < lowerWord.length - 1) {
          const digraph = lowerWord.slice(i, i + 2)
          if (LETTER_TO_PHONE[digraph]) {
            for (const p of LETTER_TO_PHONE[digraph]) {
              phones.push(p)
              tones.push(toneStart)
            }
            i += 2
            continue
          }
        }

        // Single letter
        const letter = lowerWord[i]
        if (LETTER_TO_PHONE[letter]) {
          for (const p of LETTER_TO_PHONE[letter]) {
            phones.push(p)
            tones.push(toneStart)
          }
        }
        i++
      }

      return { phones, tones }
    },
    []
  )

  // Process text and get word2ph mapping for BERT feature expansion
  const textToTokensWithWord2ph = useCallback(
    (
      text: string,
      tokenMap: Record<string, number>,
      lexiconMap: Record<string, LexiconEntry>,
      ttsConfig: TTSConfig
    ): {
      phones: number[]
      tones: number[]
      word2ph: number[]
      normalizedText: string
      normalizedWords: string[] // Array of words aligned with word2ph
    } => {
      const words = text.toLowerCase().match(/[\w']+|[.,!?;]/g) || []
      const phoneIds: number[] = []
      const toneIds: number[] = []
      const word2ph: number[] = [] // Number of phones per word
      const normalizedWords: string[] = []
      const toneStart = ttsConfig.tone_start

      for (const word of words) {
        let result: { phones: string[]; tones: number[] } | null = null

        // 1. Try lexicon first
        if (lexiconMap[word]) {
          const entry = lexiconMap[word]
          result = { phones: entry.phones, tones: entry.tones }
        }
        // 2. Handle punctuation
        else if (/^[.,!?;:'"()\-]$/.test(word)) {
          if (tokenMap[word] !== undefined) {
            phoneIds.push(tokenMap[word])
            toneIds.push(0)
            word2ph.push(1)
            normalizedWords.push(word)
          }
          continue
        }
        // 3. Fallback to simple G2P
        else {
          result = simpleG2P(word, toneStart)
        }

        // Add phones if found
        if (result && result.phones.length > 0) {
          let wordPhoneCount = 0
          for (let i = 0; i < result.phones.length; i++) {
            const phone = result.phones[i]
            if (tokenMap[phone] !== undefined) {
              phoneIds.push(tokenMap[phone])
              toneIds.push(result.tones[i] || toneStart)
              wordPhoneCount++
            }
          }
          if (wordPhoneCount > 0) {
            word2ph.push(wordPhoneCount)
            normalizedWords.push(word)
          }
        }
      }

      return {
        phones: phoneIds,
        tones: toneIds,
        word2ph,
        normalizedText: normalizedWords.join(" "),
        normalizedWords, // Return array for BERT alignment
      }
    },
    [simpleG2P]
  )

  // Add blank tokens (helper for BERT)
  const addBlanks = useCallback((arr: number[]) => {
    const result = [0]
    for (const item of arr) {
      result.push(item)
      result.push(0)
    }
    return result
  }, [])

  // Extract BERT features and expand to phone-level
  const getBertFeatures = useCallback(
    async (
      normalizedWords: string[], // Changed from text: string for alignment
      word2ph: number[],
      vocabMap: Record<string, number>,
      bertSession: any
    ): Promise<Float32Array> => {
      // Tokenize for BERT using normalizedWords (aligned with word2ph)
      const { inputIds, attentionMask, tokens } = bertTokenize(normalizedWords, vocabMap)

      // CRITICAL: Verify alignment
      // BERT tokens include [CLS] + words + [SEP]
      // word2ph should match the number of actual words (excluding [CLS] and [SEP])
      const expectedBertTokens = word2ph.length + 2 // +2 for [CLS] and [SEP]

      if (inputIds.length !== expectedBertTokens) {
        tLog(`⚠️ BERT alignment warning: BERT tokens (${inputIds.length}) != expected (${expectedBertTokens})`)
        tLog(`  word2ph length: ${word2ph.length}`)
        tLog(`  normalizedWords: ${normalizedWords.join(", ")}`)
        tLog(`  BERT tokens: ${tokens.join(", ")}`)
        // Continue anyway but results may be suboptimal
      }

      // Run BERT model
      const feeds = {
        input_ids: new Tensor(
          "int64",
          BigInt64Array.from(inputIds.map(BigInt)),
          [1, inputIds.length]
        ),
        attention_mask: new Tensor(
          "int64",
          BigInt64Array.from(attentionMask.map(BigInt)),
          [1, attentionMask.length]
        ),
      }

      const bertResults = await bertSession.run(feeds)
      const hiddenStates = bertResults.hidden_states.data as Float32Array // [1, seq_len, 768] flattened

      // Expand BERT features to phone-level using word2ph
      // hiddenStates shape: [bert_seq_len, 768] flattened
      // Output shape: [768, phone_seq_len] for ja_bert input
      const bertSeqLen = inputIds.length
      const phoneSeqLen = word2ph.reduce((a, b) => a + b, 0)
      const expanded = new Float32Array(768 * phoneSeqLen)

      let phoneIdx = 0
      for (let wordIdx = 0; wordIdx < word2ph.length; wordIdx++) {
        // Get BERT hidden state for this word
        // Skip [CLS] token (index 0), so word index maps to BERT index + 1
        let bertIdx = wordIdx + 1

        // Proper bounds checking with warning
        if (bertIdx >= bertSeqLen - 1) {
          tLog(`⚠️ BERT index ${bertIdx} out of bounds (bertSeqLen=${bertSeqLen}), using last valid token`)
          bertIdx = bertSeqLen - 2 // Use last valid BERT token (before [SEP])
        }

        // Repeat for word2ph[wordIdx] phones
        const repeatCount = word2ph[wordIdx]
        for (let r = 0; r < repeatCount; r++) {
          for (let d = 0; d < 768; d++) {
            // BERT output is [batch, seq, features] = [1, bert_seq_len, 768]
            // Flatten index: (bertIdx * 768 + d)
            // Target is [768, phone_seq_len] where we iterate over d first, then phoneIdx
            expanded[d * phoneSeqLen + phoneIdx] = hiddenStates[bertIdx * 768 + d]
          }
          phoneIdx++
        }
      }

      return expanded // [768 * phoneSeqLen] representing [768, phoneSeqLen]
    },
    [bertTokenize]
  )

  const downloadModel = useCallback(
    async (model: TTSModel) => {
      const directory = await getModelDirectory()
      const file = new File(directory, model.filename)

      const updateModelFileInfo = () => {
        try {
          const stats = file.info()
          if (!stats.exists) throw new Error("File not found")
          setModelFiles((prev) => ({
            ...prev,
            [model.id]: {
              path: file.uri,
              size: Number(stats.size) || 0,
            },
          }))
        } catch (statError) {
          console.warn(`Failed to stat model file ${model.id}:`, statError)
        }
      }

      // Check if file already exists
      let existingInfo
      try {
        existingInfo = file.info()
      } catch (infoError) {
        existingInfo = { exists: false }
      }

      if (existingInfo.exists) {
        console.log(`Model ${model.id} already exists at ${file.uri}`)
        updateModelFileInfo()
        return file.uri
      }

      // If no URL provided, model must be manually placed
      if (!model.url) {
        throw new Error(
          `Model file ${model.filename} not found. Please place the model files in the melo-tts-models directory.`
        )
      }

      setIsDownloading(true)
      console.log(`Downloading model ${model.id} from ${model.url}`)

      try {
        const downloadResumable = createDownloadResumable(
          model.url,
          file.uri,
          undefined,
          (progressData: DownloadProgressData) => {
            const { totalBytesWritten, totalBytesExpectedToWrite } =
              progressData
            const fraction =
              totalBytesExpectedToWrite > 0
                ? totalBytesWritten / totalBytesExpectedToWrite
                : 0
            setDownloadProgress((prev) => ({
              ...prev,
              [model.id]: fraction,
            }))
          }
        )

        const downloadResult = (await downloadResumable.downloadAsync()) as
          | FileSystemDownloadResult
          | undefined

        if (
          downloadResult &&
          (downloadResult.status === 0 ||
            (downloadResult.status >= 200 && downloadResult.status < 300))
        ) {
          console.log(`Successfully downloaded model ${model.id}`)
          updateModelFileInfo()
          setDownloadProgress((prev) => ({ ...prev, [model.id]: 1 }))
          return file.uri
        } else {
          throw new Error(
            `Download failed with status: ${downloadResult?.status}`
          )
        }
      } catch (error) {
        console.error(`Error downloading model ${model.id}:`, error)
        throw error
      } finally {
        setIsDownloading(false)
      }
    },
    [getModelDirectory]
  )

  const initializeModel = useCallback(
    async (modelId: string, sourceOverride?: ModelSource) => {
      const model = TTS_MODELS.find((m) => m.id === modelId)
      if (!model) throw new Error("Invalid model selected")

      const isBertModel = modelId === "melo-bert"

      try {
        setIsInitializingModel(true)
        setOnnxError(null)
        const targetSource = sourceOverride ?? currentModelSource
        tLog(
          `Initializing TTS model: ${model.label} from source: ${targetSource}${isBertModel ? " (BERT-enhanced)" : ""}`
        )

        const directory = await getModelDirectoryForSource(targetSource)

        // Get model file path from the correct directory
        const modelFile = new File(directory, model.filename)
        if (!modelFile.info().exists) {
          throw new Error(
            `Model file ${model.filename} not found in ${targetSource} directory. Please download the models first.`
          )
        }
        const modelPath = modelFile.uri
        tLog(`Using model file: ${modelPath}`)

        // Load tokens.txt
        const tokensFile = new File(directory, "tokens.txt")
        if (!tokensFile.info().exists) {
          throw new Error("tokens.txt not found in model directory")
        }
        const loadedTokens = await loadTokens(tokensFile.uri)
        setTokens(loadedTokens)

        // Load lexicon.txt
        const lexiconFile = new File(directory, "lexicon.txt")
        if (!lexiconFile.info().exists) {
          throw new Error("lexicon.txt not found in model directory")
        }
        const loadedLexicon = await loadLexicon(lexiconFile.uri)
        setLexicon(loadedLexicon)

        // Load tts_config.json
        const configFile = new File(directory, "tts_config.json")
        if (!configFile.info().exists) {
          throw new Error("tts_config.json not found in model directory")
        }
        const loadedConfig = await loadConfig(configFile.uri)
        setConfig(loadedConfig)

        // Define execution providers based on platform
        const executionProviders =
          Platform.OS === "ios"
            ? (["coreml", "xnnpack", "cpu"] as const)
            : (["nnapi", "xnnpack", "cpu"] as const)

        // For BERT models, load BERT vocabulary and BERT ONNX session
        if (isBertModel) {
          tLog("=== Loading BERT Components ===")

          // Try to load BERT vocabulary (bert_vocab.txt)
          // If not present, we'll try to download it or use a fallback
          const bertVocabFile = new File(directory, "bert_vocab.txt")
          if (bertVocabFile.info().exists) {
            const loadedBertVocab = await loadBertVocab(bertVocabFile.uri)
            setBertVocab(loadedBertVocab)
            tLog(`Loaded BERT vocabulary: ${Object.keys(loadedBertVocab).length} entries`)
          } else {
            // Create a basic vocabulary with essential tokens
            // In production, you should download the full vocab from HuggingFace
            tLog("Warning: bert_vocab.txt not found, using minimal vocabulary")
            const minimalVocab: Record<string, number> = {
              "[PAD]": 0,
              "[UNK]": 100,
              "[CLS]": 101,
              "[SEP]": 102,
              "[MASK]": 103,
            }
            // Add lowercase letters
            for (let i = 0; i < 26; i++) {
              minimalVocab[String.fromCharCode(97 + i)] = 1000 + i
            }
            setBertVocab(minimalVocab)
          }

          // Load BERT ONNX session
          const bertModelFile = new File(directory, "bert.onnx")
          if (!bertModelFile.info().exists) {
            throw new Error("bert.onnx not found in model directory. BERT model requires bert.onnx file.")
          }

          tLog("Creating BERT ONNX session...")
          const bertSessionStartTime = Date.now()
          const bertSession = await InferenceSession.create(bertModelFile.uri, {
            executionProviders: [...executionProviders],
          })
          const bertSessionLoadTime = Date.now() - bertSessionStartTime
          bertSessionRef.current = bertSession
          tLog(`BERT session created in ${bertSessionLoadTime}ms`)
          tLog("BERT input names:", bertSession.inputNames)
          tLog("BERT output names:", bertSession.outputNames)
        } else {
          // Clear BERT session for non-BERT models
          bertSessionRef.current = null
          setBertVocab({})
        }

        // Initialize TTS ONNX session with hardware acceleration
        tLog("=== TTS ONNX Session Initialization ===")
        tLog("Model path:", modelPath)
        tLog("Platform:", Platform.OS)

        tLog("Requested execution providers:", executionProviders)
        tLog("Expected hardware acceleration:")
        if (Platform.OS === "ios") {
          tLog("  - CoreML → Apple Neural Engine (ANE)")
        } else {
          tLog("  - NNAPI → Hexagon NPU (Snapdragon) / GPU")
        }

        tLog("Creating TTS ONNX session...")
        const sessionStartTime = Date.now()
        const session = await InferenceSession.create(modelPath, {
          executionProviders: [...executionProviders],
        })
        const sessionLoadTime = Date.now() - sessionStartTime

        sessionRef.current = session

        tLog(`TTS session created in ${sessionLoadTime}ms`)
        tLog("TTS input names:", session.inputNames)
        tLog("TTS output names:", session.outputNames)
        tLog("=== TTS Session Ready ===")

        setCurrentModelId(modelId)
        tLog(`TTS model initialized: ${model.label}`)

        return {
          session,
          bertSession: bertSessionRef.current,
          tokens: loadedTokens,
          lexicon: loadedLexicon,
          bertVocab: isBertModel ? bertVocab : {},
          config: loadedConfig,
        }
      } catch (error) {
        console.error("Model initialization error:", error)
        setOnnxError(`Failed to initialize: ${error}`)
        throw error
      } finally {
        setIsInitializingModel(false)
      }
    },
    [
      getModelDirectoryForSource,
      currentModelSource,
      loadTokens,
      loadLexicon,
      loadConfig,
      loadBertVocab,
      bertVocab,
    ]
  )

  const isPunctuation = useCallback((word: string): boolean => {
    return /^[.,!?;:'"()\-]$/.test(word)
  }, [])

  const textToTokens = useCallback(
    (
      text: string,
      tokenMap: Record<string, number>,
      lexiconMap: Record<string, LexiconEntry>,
      ttsConfig: TTSConfig
    ): { phones: number[]; tones: number[] } => {
      const words = text.toLowerCase().match(/[\w']+|[.,!?;]/g) || []
      const phoneIds: number[] = []
      const toneIds: number[] = []
      const toneStart = ttsConfig.tone_start

      for (const word of words) {
        let result: { phones: string[]; tones: number[] } | null = null

        // 1. Try lexicon first
        if (lexiconMap[word]) {
          const entry = lexiconMap[word]
          result = { phones: entry.phones, tones: entry.tones }
        }
        // 2. Handle punctuation
        else if (isPunctuation(word)) {
          if (tokenMap[word] !== undefined) {
            phoneIds.push(tokenMap[word])
            toneIds.push(0)
          }
          continue
        }
        // 3. Fallback to simple G2P
        else {
          result = simpleG2P(word, toneStart)
        }

        // Add phones if found
        if (result) {
          for (let i = 0; i < result.phones.length; i++) {
            const phone = result.phones[i]
            if (tokenMap[phone] !== undefined) {
              phoneIds.push(tokenMap[phone])
              toneIds.push(result.tones[i] || toneStart)
            }
          }
        }
      }

      // Add blanks between phonemes if config says so
      if (ttsConfig.add_blank) {
        const phonesWithBlanks = [0]
        const tonesWithBlanks = [0]
        for (let i = 0; i < phoneIds.length; i++) {
          phonesWithBlanks.push(phoneIds[i])
          tonesWithBlanks.push(toneIds[i])
          phonesWithBlanks.push(0)
          tonesWithBlanks.push(0)
        }
        return { phones: phonesWithBlanks, tones: tonesWithBlanks }
      }

      return { phones: phoneIds, tones: toneIds }
    },
    [isPunctuation, simpleG2P]
  )

  const float32ToWav = useCallback(
    (audioData: Float32Array, sampleRate: number): string => {
      const numSamples = audioData.length
      const buffer = new ArrayBuffer(44 + numSamples * 2)
      const view = new DataView(buffer)

      const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) {
          view.setUint8(offset + i, str.charCodeAt(i))
        }
      }

      // WAV header
      writeString(0, "RIFF")
      view.setUint32(4, 36 + numSamples * 2, true)
      writeString(8, "WAVE")
      writeString(12, "fmt ")
      view.setUint32(16, 16, true) // fmt chunk size
      view.setUint16(20, 1, true) // PCM
      view.setUint16(22, 1, true) // mono
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true) // byte rate
      view.setUint16(32, 2, true) // block align
      view.setUint16(34, 16, true) // bits per sample
      writeString(36, "data")
      view.setUint32(40, numSamples * 2, true)

      // Audio data - convert float32 [-1, 1] to int16
      for (let i = 0; i < numSamples; i++) {
        const sample = Math.max(-1, Math.min(1, audioData[i]))
        view.setInt16(44 + i * 2, sample * 0x7fff, true)
      }

      // Convert to base64
      const bytes = new Uint8Array(buffer)
      let binary = ""
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      return btoa(binary)
    },
    []
  )

  const synthesize = useCallback(
    async (
      text: string,
      options: {
        speakerId?: number
        noiseScale?: number
        lengthScale?: number
        noiseScaleW?: number
      } = {}
    ): Promise<{ audio: Float32Array; sampleRate: number }> => {
      if (!sessionRef.current || !config) {
        throw new Error("TTS model not initialized")
      }

      const {
        speakerId = 0,
        noiseScale = 0.6,
        lengthScale = 1.0,
        noiseScaleW = 0.8,
      } = options

      // Check if we're using a BERT model
      const isBertModel = config.requires_bert === true && bertSessionRef.current !== null

      let phones: number[]
      let tones: number[]
      let seqLen: number
      let bertFeatures: Float32Array | null = null

      if (isBertModel) {
        // BERT model flow: get word2ph mapping for feature expansion
        tLog("Using BERT-enhanced synthesis pipeline")
        
        const { phones: rawPhones, tones: rawTones, word2ph, normalizedWords } = 
          textToTokensWithWord2ph(text, tokens, lexicon, config)

        if (rawPhones.length === 0) {
          throw new Error("No valid phonemes generated from text")
        }

        tLog(`Processed ${normalizedWords.length} words, ${rawPhones.length} phones`)

        // Add blanks to phones/tones
        const phonesWithBlanks = addBlanks(rawPhones)
        const tonesWithBlanks = addBlanks(rawTones)
        seqLen = phonesWithBlanks.length
        phones = phonesWithBlanks
        tones = tonesWithBlanks

        // Modify word2ph for blanks BEFORE BERT feature extraction
        // - Double each count (blank between each phone)
        // - Add 1 to first (leading blank)
        const word2phModified = [...word2ph]
        for (let i = 0; i < word2phModified.length; i++) {
          word2phModified[i] = word2phModified[i] * 2
        }
        if (word2phModified.length > 0) {
          word2phModified[0] += 1
        }

        // Verify: sum of modified word2ph should equal seqLen
        const expectedLen = word2phModified.reduce((a, b) => a + b, 0)
        if (expectedLen !== seqLen) {
          tLog(`⚠️ Warning: word2ph sum (${expectedLen}) != seqLen (${seqLen})`)
        }

        // Get BERT features with normalizedWords (aligned with word2ph)
        tLog("Extracting BERT features...")
        const bertStart = Date.now()
        bertFeatures = await getBertFeatures(
          normalizedWords, // Use normalizedWords array for proper alignment
          word2phModified,
          bertVocab,
          bertSessionRef.current
        )
        const bertTime = Date.now() - bertStart
        tLog(`BERT feature extraction: ${bertTime}ms`)
      } else {
        // Standard (non-BERT) flow
        const result = textToTokens(text, tokens, lexicon, config)
        phones = result.phones
        tones = result.tones
        seqLen = phones.length

        if (seqLen === 0) {
          throw new Error("No valid phonemes generated from text")
        }
      }

      tLog(`Synthesizing: "${text}" -> ${seqLen} tokens${isBertModel ? " (BERT-enhanced)" : ""}`)

      // Create input tensors using onnxruntime-react-native Tensor
      const feeds: Record<string, any> = {
        x: new Tensor("int64", BigInt64Array.from(phones.map(BigInt)), [
          1,
          seqLen,
        ]),
        x_lengths: new Tensor("int64", BigInt64Array.from([BigInt(seqLen)]), [
          1,
        ]),
        tones: new Tensor("int64", BigInt64Array.from(tones.map(BigInt)), [
          1,
          seqLen,
        ]),
        sid: new Tensor("int64", BigInt64Array.from([BigInt(speakerId)]), [1]),
        noise_scale: new Tensor("float32", Float32Array.from([noiseScale]), [
          1,
        ]),
        length_scale: new Tensor("float32", Float32Array.from([lengthScale]), [
          1,
        ]),
        noise_scale_w: new Tensor("float32", Float32Array.from([noiseScaleW]), [
          1,
        ]),
      }

      // Add BERT features for BERT models (ja_bert input)
      if (isBertModel && bertFeatures) {
        // ja_bert shape: [1, 768, seq_len]
        feeds.ja_bert = new Tensor("float32", bertFeatures, [1, 768, seqLen])
        tLog(`Added ja_bert tensor: [1, 768, ${seqLen}]`)
      }

      // Run inference with timing
      const inferenceStart = Date.now()
      const results = await sessionRef.current.run(feeds)
      const inferenceEnd = Date.now()
      const inferenceTimeMs = inferenceEnd - inferenceStart

      // Get audio data - output shape is [1, 1, samples]
      const audioData = results.y.data as Float32Array

      // Calculate audio duration
      const audioDurationSec = audioData.length / config.sample_rate

      // Calculate real-time factor (RTF) - lower is better, <1 means faster than real-time
      const rtf = inferenceTimeMs / 1000 / audioDurationSec

      // Store timing info
      setLastInferenceTime(inferenceTimeMs)
      setLastAudioDuration(audioDurationSec)

      // Log detailed performance info
      tLog("=== TTS Inference Performance ===")
      tLog(`Platform: ${Platform.OS}`)
      tLog(`Model type: ${isBertModel ? "BERT-enhanced" : "Standard"}`)
      tLog(
        `Expected accelerator: ${
          Platform.OS === "ios" ? "CoreML/ANE" : "NNAPI/Hexagon NPU"
        }`
      )
      tLog(`Input tokens: ${seqLen}`)
      tLog(`Inference time: ${inferenceTimeMs}ms`)
      tLog(
        `Audio duration: ${audioDurationSec.toFixed(2)}s (${
          audioData.length
        } samples)`
      )
      tLog(`Real-time factor (RTF): ${rtf.toFixed(3)}`)

      // Performance interpretation
      if (rtf < 0.5) {
        tLog("✅ EXCELLENT - Hardware acceleration likely working (NPU/ANE)")
      } else if (rtf < 1.0) {
        tLog(
          "✅ GOOD - Faster than real-time, may be using XNNPACK or partial NPU"
        )
      } else if (rtf < 2.0) {
        tLog("⚠️ MODERATE - Likely using XNNPACK CPU optimization")
      } else {
        tLog("❌ SLOW - Likely falling back to basic CPU, NPU not engaged")
      }
      tLog("=================================")

      return {
        audio: audioData,
        sampleRate: config.sample_rate,
      }
    },
    [config, tokens, lexicon, bertVocab, textToTokens, textToTokensWithWord2ph, addBlanks, getBertFeatures]
  )

  const synthesizeToFile = useCallback(
    async (
      text: string,
      outputPath: string,
      options: {
        speakerId?: number
        noiseScale?: number
        lengthScale?: number
        noiseScaleW?: number
      } = {}
    ): Promise<{ outputPath: string; audioDuration: number }> => {
      setIsSynthesizing(true)
      try {
        const { audio, sampleRate } = await synthesize(text, options)

        // Calculate actual audio duration from samples
        const audioDuration = audio.length / sampleRate

        // Convert to WAV
        const wavBase64 = float32ToWav(audio, sampleRate)

        // Write file
        const file = new File(outputPath)
        const directory = file.parentDirectory
        if (directory && !directory.exists) {
          directory.create({ intermediates: true })
        }

        // Write base64 data
        await writeAsStringAsync(outputPath, wavBase64, {
          encoding: EncodingType.Base64,
        })

        tLog(`Audio saved to: ${outputPath} (duration: ${audioDuration.toFixed(2)}s)`)
        return { outputPath, audioDuration }
      } finally {
        setIsSynthesizing(false)
      }
    },
    [synthesize, float32ToWav]
  )

  /**
   * Synthesize long text by chunking it into sentences and concatenating audio with silence gaps.
   * This provides more natural speech with pauses between sentences.
   */
  const synthesizeLongText = useCallback(
    async (
      text: string,
      options: {
        speakerId?: number
        noiseScale?: number
        lengthScale?: number
        noiseScaleW?: number
        /** Silence gap between chunks in milliseconds (default 50ms) */
        silenceGapMs?: number
      } = {}
    ): Promise<{ audio: Float32Array; sampleRate: number; chunks: string[] }> => {
      if (!sessionRef.current || !config) {
        throw new Error("TTS model not initialized")
      }

      const { silenceGapMs = 50, ...synthesizeOptions } = options

      // Split text into chunks
      const chunks = textChunker.splitText(text)
      tLog(`Split text into ${chunks.length} chunks:`)
      chunks.forEach((chunk, i) => tLog(`  [${i + 1}] "${chunk.slice(0, 50)}${chunk.length > 50 ? '...' : ''}"`))

      if (chunks.length === 0) {
        throw new Error("No valid text chunks generated")
      }

      // Synthesize each chunk
      const audioChunks: Float32Array[] = []
      let totalInferenceTime = 0

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        tLog(`Synthesizing chunk ${i + 1}/${chunks.length}...`)
        
        const startTime = Date.now()
        const { audio } = await synthesize(chunk, synthesizeOptions)
        const chunkTime = Date.now() - startTime
        totalInferenceTime += chunkTime
        
        audioChunks.push(audio)
        tLog(`  Chunk ${i + 1} done: ${audio.length} samples in ${chunkTime}ms`)
      }

      // Concatenate with silence gaps
      const speed = options.lengthScale ?? 1.0
      const combinedAudio = concatAudioChunks(
        audioChunks,
        config.sample_rate,
        silenceGapMs,
        speed
      )

      // Calculate total audio duration
      const audioDurationSec = combinedAudio.length / config.sample_rate
      const rtf = totalInferenceTime / 1000 / audioDurationSec

      // Update timing info
      setLastInferenceTime(totalInferenceTime)
      setLastAudioDuration(audioDurationSec)

      tLog("=== Long Text Synthesis Complete ===")
      tLog(`Total chunks: ${chunks.length}`)
      tLog(`Total inference time: ${totalInferenceTime}ms`)
      tLog(`Total audio duration: ${audioDurationSec.toFixed(2)}s`)
      tLog(`Overall RTF: ${rtf.toFixed(3)}`)
      tLog("====================================")

      return {
        audio: combinedAudio,
        sampleRate: config.sample_rate,
        chunks,
      }
    },
    [config, synthesize]
  )

  /**
   * Synthesize long text to a WAV file with natural pauses between sentences.
   */
  const synthesizeLongTextToFile = useCallback(
    async (
      text: string,
      outputPath: string,
      options: {
        speakerId?: number
        noiseScale?: number
        lengthScale?: number
        noiseScaleW?: number
        silenceGapMs?: number
      } = {}
    ): Promise<{ path: string; chunks: string[] }> => {
      setIsSynthesizing(true)
      try {
        const { audio, sampleRate, chunks } = await synthesizeLongText(text, options)

        // Convert to WAV
        const wavBase64 = float32ToWav(audio, sampleRate)

        // Write file
        const file = new File(outputPath)
        const directory = file.parentDirectory
        if (directory && !directory.exists) {
          directory.create({ intermediates: true })
        }

        await writeAsStringAsync(outputPath, wavBase64, {
          encoding: EncodingType.Base64,
        })

        tLog(`Long text audio saved to: ${outputPath}`)
        return { path: outputPath, chunks }
      } finally {
        setIsSynthesizing(false)
      }
    },
    [synthesizeLongText, float32ToWav]
  )

  const playAudio = useCallback(
    async (filePath: string, options?: { rate?: number }) => {
      try {
        // Stop any existing playback
        if (audioPlayerRef.current) {
          audioPlayerRef.current.remove()
          audioPlayerRef.current = null
        }

        // Configure audio session for iOS playback (allows audio even when mute switch is on)
        if (Platform.OS === "ios") {
          try {
            await AudioModule.setAudioModeAsync({
              playsInSilentMode: true, // Play even when mute switch is on
            })
          } catch (audioModeError) {
            console.warn("Failed to set audio mode:", audioModeError)
          }
        }

        // Create and play audio using expo-audio AudioPlayer
        const player = new AudioModule.AudioPlayer(
          { uri: filePath },
          500,
          false
        )
        audioPlayerRef.current = player

        // Set playback rate if specified (done at native level, zero latency overhead)
        if (options?.rate && options.rate !== 1.0) {
          player.setPlaybackRate(options.rate, "high")
          tLog(`Audio playback started at ${options.rate}x speed`)
        } else {
          tLog("Audio playback started")
        }

        player.play()
      } catch (error) {
        console.error("Audio playback error:", error)
        throw error
      }
    },
    []
  )

  const stopAudio = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause()
      audioPlayerRef.current.remove()
      audioPlayerRef.current = null
      tLog("Audio playback stopped")
    }
  }, [])

  const speakText = useCallback(
    async (
      text: string,
      options: {
        speakerId?: number
        noiseScale?: number
        lengthScale?: number
        noiseScaleW?: number
        /** Playback rate (0.5 to 2.0, default 1.0). Applied at native level with zero latency. */
        playbackRate?: number
        /** Silence gap between chunks in milliseconds (default 50ms) */
        silenceGapMs?: number
        /** Force chunking even for short text (default: auto based on length) */
        forceChunking?: boolean
      } = {}
    ) => {
      const directory = await getModelDirectory()
      const outputPath = new File(directory, `speech_${Date.now()}.wav`).uri

      // Use chunked synthesis for longer text (> 100 chars) or if forced
      const shouldChunk = options.forceChunking || text.length > 100

      if (shouldChunk) {
        tLog(`Using chunked synthesis for text (${text.length} chars)`)
        await synthesizeLongTextToFile(text, outputPath, {
          speakerId: options.speakerId,
          noiseScale: options.noiseScale,
          lengthScale: options.lengthScale,
          noiseScaleW: options.noiseScaleW,
          silenceGapMs: options.silenceGapMs,
        })
      } else {
        await synthesizeToFile(text, outputPath, options)
      }

      await playAudio(outputPath, { rate: options.playbackRate })

      return outputPath
    },
    [getModelDirectory, synthesizeToFile, synthesizeLongTextToFile, playAudio]
  )

  const resetModel = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current = null
    }
    if (bertSessionRef.current) {
      bertSessionRef.current = null
    }
    stopAudio()
    setTokens({})
    setLexicon({})
    setBertVocab({})
    setConfig(null)
    setCurrentModelId(null)
    setOnnxError(null)
    console.log("TTS model reset")
  }, [stopAudio])

  // Delete TTS model source (removes downloaded files)
  const deleteModelSource = useCallback(
    async (source: ModelSource): Promise<boolean> => {
      try {
        tLog(`Deleting TTS model source: ${source}...`)

        // Reset model if we're currently using this source
        if (currentModelSource === source) {
          resetModel()
        }

        // Get the directory for this source
        const directory = await getModelDirectoryForSource(source)

        // Delete the directory and all its contents
        if (directory.exists) {
          // List and delete all files in the directory
          try {
            const contents = directory.list()
            for (const item of contents) {
              try {
                if (typeof item === "string") {
                  const file = new File(directory, item)
                  if (file.exists) {
                    file.delete()
                    tLog(`Deleted: ${item}`)
                  }
                } else {
                  // It's a File or Directory object
                  const itemPath = (item as any).uri || (item as any).path
                  if (itemPath) {
                    const file = new File(itemPath)
                    if (file.exists) file.delete()
                  }
                }
              } catch (e) {
                console.warn(`Failed to delete item:`, e)
              }
            }
          } catch (e) {
            console.warn("Failed to list directory contents:", e)
          }

          // Delete the directory itself
          try {
            directory.delete()
            tLog(`Deleted directory: ${source}`)
          } catch (e) {
            console.warn("Failed to delete directory:", e)
          }
        }

        // Update downloaded sources state
        setDownloadedSources((prev) => ({
          ...prev,
          [source]: false,
        }))

        // Refresh model files
        await refreshModelFiles(source)
        await refreshDownloadedSources()

        tLog(`TTS model source ${source} deleted successfully`)
        return true
      } catch (error) {
        console.error(`Failed to delete TTS model source ${source}:`, error)
        return false
      }
    },
    [
      currentModelSource,
      resetModel,
      getModelDirectoryForSource,
      refreshModelFiles,
      refreshDownloadedSources,
    ]
  )

  const getModelById = useCallback((modelId: string) => {
    return TTS_MODELS.find((m) => m.id === modelId)
  }, [])

  const getCurrentModel = useCallback(() => {
    return currentModelId ? getModelById(currentModelId) : null
  }, [currentModelId, getModelById])

  const isModelDownloaded = useCallback(
    (modelId: string) => {
      return modelFiles[modelId] !== undefined
    },
    [modelFiles]
  )

  const getDownloadProgress = useCallback(
    (modelId: string) => {
      return downloadProgress[modelId] || 0
    },
    [downloadProgress]
  )

  const isReady = useCallback(() => {
    return sessionRef.current !== null && config !== null && !onnxError
  }, [config, onnxError])

  const checkOnnxAvailability = useCallback(async () => {
    try {
      // Attempt to create a dummy session or just ensure the module is loaded
      // For direct import, simply checking if InferenceSession is available is enough
      if (typeof InferenceSession.create === "function") {
        setOnnxError(null)
        return true
      }
      throw new Error("InferenceSession.create is not a function.")
    } catch (error) {
      const errorMsg = `${error}`
      setOnnxError(errorMsg)
      return false
    }
  }, [])

  // Load existing models on mount
  useEffect(() => {
    let isMounted = true

    const loadExistingModels = async () => {
      try {
        const directory = await getModelDirectory()
        const entries = await Promise.all(
          TTS_MODELS.map(async (model) => {
            const file = new File(directory, model.filename)
            try {
              const fileInfo = file.info()
              if (!fileInfo.exists) return null

              return {
                id: model.id,
                info: {
                  path: file.uri,
                  size: Number(fileInfo.size) || 0,
                },
              }
            } catch (statError) {
              return null
            }
          })
        )

        if (!isMounted) return

        const fileMap: Record<string, ModelFileInfo> = {}
        entries.forEach((entry) => {
          if (entry) {
            fileMap[entry.id] = entry.info
          }
        })

        if (Object.keys(fileMap).length > 0) {
          setModelFiles((prev) => ({ ...prev, ...fileMap }))
        }
      } catch (error) {
        console.warn("Failed to load existing TTS models:", error)
      }
    }

    loadExistingModels()
    // Also check which sources have been downloaded
    refreshDownloadedSources()

    return () => {
      isMounted = false
    }
  }, [getModelDirectory, refreshDownloadedSources])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAudio()
    }
  }, [stopAudio])

  return {
    // State
    modelFiles,
    downloadProgress,
    downloadSpeed,
    isDownloading,
    isInitializingModel,
    isSynthesizing,
    lastInferenceTime,
    lastAudioDuration,
    currentModelId,
    config,
    onnxError,
    currentModelSource,
    downloadedSources,

    // Actions
    downloadAndExtractModels,
    switchModelSource,
    deleteModelSource,
    initializeModel,
    resetModel,
    synthesize,
    synthesizeToFile,
    synthesizeLongText,
    synthesizeLongTextToFile,
    speakText,
    playAudio,
    stopAudio,
    checkOnnxAvailability,
    refreshDownloadedSources,

    // Helpers
    getModelById,
    getCurrentModel,
    isModelDownloaded,
    getDownloadProgress,
    isReady,
    getModelDirectory,
    getModelDirectoryForSource,
    refreshModelFiles,
    checkSourceDownloaded,

    // Constants
    availableModels: TTS_MODELS,
  }
}
