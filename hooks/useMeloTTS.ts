/**
 * MeloTTS ONNX model integration for React Native
 * 
 * Model files required in document directory 'melo-tts-models/':
 * - model_int8.onnx (or model.onnx)
 * - tokens.txt
 * - lexicon.txt
 * - tts_config.json
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import {
  createDownloadResumable,
  type DownloadProgressData,
  type FileSystemDownloadResult,
  writeAsStringAsync,
  EncodingType,
  cacheDirectory,
} from "expo-file-system/legacy";
import AudioModule from "expo-audio/build/AudioModule";
import { unzip } from "react-native-zip-archive";

// Import ONNX runtime directly as per docs
import { InferenceSession, Tensor } from "onnxruntime-react-native";

// S3 URLs for MeloTTS model files
// Default MeloTTS variant
export const MELO_TTS_MODELS_URL = "https://test-transcription-service-nxtwave.s3.ap-south-1.amazonaws.com/melo-tts-models.zip";
// Custom model variant
export const MELO_TTS_CUSTOM_MODEL_URL = "https://test-transcription-service-nxtwave.s3.ap-south-1.amazonaws.com/default_export.zip";

// Helper to get formatted timestamp for logs
const getTimestamp = () => {
  const now = new Date();
  return `[${now.toLocaleTimeString('en-US', { hour12: false })}.${now.getMilliseconds().toString().padStart(3, '0')}]`;
};

// Timestamped log helper
const tLog = (...args: any[]) => console.log(getTimestamp(), ...args);

export interface TTSModel {
  id: string;
  label: string;
  url: string;
  filename: string;
  expectedSize: number;
  quality: string;
}

export interface TTSConfig {
  language: string;
  lang_id: number;
  tone_start: number;
  sample_rate: number;
  add_blank: boolean;
  n_speakers: number;
  spk2id: Record<string, number>;
}

interface LexiconEntry {
  phones: string[];
  tones: number[];
}

interface ModelFileInfo {
  path: string;
  size: number;
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
];

// Simple letter-to-phoneme fallback
const LETTER_TO_PHONE: Record<string, string[]> = {
  'a': ['ae'], 'b': ['b'], 'c': ['k'], 'd': ['d'], 'e': ['eh'],
  'f': ['f'], 'g': ['g'], 'h': ['hh'], 'i': ['ih'], 'j': ['jh'],
  'k': ['k'], 'l': ['l'], 'm': ['m'], 'n': ['n'], 'o': ['ow'],
  'p': ['p'], 'q': ['k', 'w'], 'r': ['r'], 's': ['s'], 't': ['t'],
  'u': ['ah'], 'v': ['v'], 'w': ['w'], 'x': ['k', 's'], 'y': ['y'],
  'z': ['z'],
  // Common digraphs
  'th': ['th'], 'sh': ['sh'], 'ch': ['ch'], 'ph': ['f'],
  'wh': ['w'], 'ck': ['k'], 'ng': ['ng'],
};

// Model source types
export type ModelSource = 'default' | 'custom';

export function useMeloTTS() {
  const [modelFiles, setModelFiles] = useState<Record<string, ModelFileInfo>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [downloadSpeed, setDownloadSpeed] = useState<string>("");
  const downloadStartTimeRef = useRef<number>(0);
  const lastBytesRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isInitializingModel, setIsInitializingModel] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [lastInferenceTime, setLastInferenceTime] = useState<number | null>(null); // in milliseconds
  const [lastAudioDuration, setLastAudioDuration] = useState<number | null>(null); // in seconds
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [onnxError, setOnnxError] = useState<string | null>(null);
  
  // Track current model source and which sources are downloaded
  const [currentModelSource, setCurrentModelSource] = useState<ModelSource>('default');
  const [downloadedSources, setDownloadedSources] = useState<Record<ModelSource, boolean>>({
    default: false,
    custom: false,
  });
  
  // Model resources
  const sessionRef = useRef<any>(null); // InferenceSession from onnxruntime-react-native
  const [tokens, setTokens] = useState<Record<string, number>>({});
  const [lexicon, setLexicon] = useState<Record<string, LexiconEntry>>({});
  const [config, setConfig] = useState<TTSConfig | null>(null);
  
  // Audio player
  const audioPlayerRef = useRef<any>(null);

  // Get directory for a specific model source
  const getModelDirectoryForSource = useCallback(async (source: ModelSource) => {
    let documentDirectory: Directory;
    try {
      documentDirectory = Paths.document;
    } catch (error) {
      throw new Error("Document directory is not available.");
    }

    if (!documentDirectory?.uri) {
      throw new Error("Document directory is not available.");
    }

    const dirName = source === 'custom' ? 'melo-tts-custom' : 'melo-tts-default';
    const directory = new Directory(documentDirectory, dirName);
    try {
      directory.create({ idempotent: true, intermediates: true });
    } catch (error) {
      console.warn(`Failed to ensure ${dirName} directory exists:`, error);
      throw error;
    }
    return directory;
  }, []);

  // Get current model directory based on active source
  const getModelDirectory = useCallback(async () => {
    return getModelDirectoryForSource(currentModelSource);
  }, [currentModelSource, getModelDirectoryForSource]);

  // Check if a model source has been downloaded
  const checkSourceDownloaded = useCallback(async (source: ModelSource): Promise<boolean> => {
    try {
      const directory = await getModelDirectoryForSource(source);
      const modelFiles = [
        new File(directory, "model_int8.onnx"),
        new File(directory, "model_fp16.onnx"),
        new File(directory, "model_mixed.onnx"),
        new File(directory, "model.onnx"),
      ];
      
      const hasAnyModel = modelFiles.some(f => {
        try { return f.info().exists; } catch { return false; }
      });
      
      return hasAnyModel;
    } catch {
      return false;
    }
  }, [getModelDirectoryForSource]);

  // Refresh downloaded sources state
  const refreshDownloadedSources = useCallback(async () => {
    const defaultDownloaded = await checkSourceDownloaded('default');
    const customDownloaded = await checkSourceDownloaded('custom');
    
    setDownloadedSources({
      default: defaultDownloaded,
      custom: customDownloaded,
    });
    
    tLog(`Downloaded sources: default=${defaultDownloaded}, custom=${customDownloaded}`);
    
    return { default: defaultDownloaded, custom: customDownloaded };
  }, [checkSourceDownloaded]);

  const refreshModelFiles = useCallback(async (source?: ModelSource) => {
    try {
      const targetSource = source ?? currentModelSource;
      const directory = await getModelDirectoryForSource(targetSource);
      const fileMap: Record<string, ModelFileInfo> = {};
      
      for (const model of TTS_MODELS) {
        const file = new File(directory, model.filename);
        try {
          const fileInfo = file.info();
          if (fileInfo.exists) {
            fileMap[model.id] = {
              path: file.uri,
              size: Number(fileInfo.size) || 0,
            };
            console.log(`Found model file: ${model.filename} (${fileInfo.size} bytes)`);
          }
        } catch (e) {
          // File doesn't exist
        }
      }
      
      setModelFiles(fileMap);
      console.log(`Refreshed model files for ${targetSource}: ${Object.keys(fileMap).length} found`);
      return fileMap;
    } catch (error) {
      console.error("Failed to refresh model files:", error);
      return {};
    }
  }, [currentModelSource, getModelDirectoryForSource]);

  const downloadAndExtractModels = useCallback(async (source: ModelSource = 'default'): Promise<boolean> => {
    try {
      setIsDownloading(true);
      setDownloadProgress({ models: 0 });
      const modelUrl = source === 'custom' ? MELO_TTS_CUSTOM_MODEL_URL : MELO_TTS_MODELS_URL;
      tLog(`Starting MeloTTS models download from S3... (${source})`);

      // Get source-specific directory
      const directory = await getModelDirectoryForSource(source);
      
      // Check if any model file already exists in this source's directory
      const existingModelFiles = [
        new File(directory, "model_int8.onnx"),
        new File(directory, "model_fp16.onnx"),
        new File(directory, "model_mixed.onnx"),
        new File(directory, "model.onnx"),
      ];
      
      // Check if models already exist
      try {
        const hasAnyModel = existingModelFiles.some(f => {
          try { return f.info().exists; } catch { return false; }
        });
        if (hasAnyModel) {
          tLog(`MeloTTS ${source} model already downloaded, switching to it...`);
          setCurrentModelSource(source);
          await refreshModelFiles(source);
          await refreshDownloadedSources();
          setDownloadProgress({ models: 1 });
          return true;
        }
      } catch (e) {
        // Files don't exist, proceed with download
      }
      
      // List what's in the directory for debugging
      console.log("Model directory contents before download:");
      try {
        const contents = directory.list();
        contents.forEach(item => console.log(`  - ${item}`));
      } catch (e) {
        console.log("  (empty or error listing)");
      }

      // Download zip to cache directory
      const zipPath = `${cacheDirectory}melo-tts-models.zip`;
      console.log("Downloading zip to:", zipPath);

      // Reset speed tracking
      downloadStartTimeRef.current = Date.now();
      lastBytesRef.current = 0;
      lastTimeRef.current = Date.now();
      setDownloadSpeed("");

      const downloadResumable = createDownloadResumable(
        modelUrl,
        zipPath,
        {},
        (progressData: DownloadProgressData) => {
          const { totalBytesWritten, totalBytesExpectedToWrite } = progressData;
          const fraction = totalBytesExpectedToWrite > 0 
            ? totalBytesWritten / totalBytesExpectedToWrite 
            : 0;
          setDownloadProgress({ models: fraction * 0.8 }); // 80% for download
          
          // Calculate speed
          const now = Date.now();
          const timeDiff = (now - lastTimeRef.current) / 1000; // seconds
          if (timeDiff >= 0.5) { // Update speed every 0.5 seconds
            const bytesDiff = totalBytesWritten - lastBytesRef.current;
            const speed = bytesDiff / timeDiff; // bytes per second
            
            // Format speed
            let speedStr = "";
            if (speed >= 1024 * 1024) {
              speedStr = `${(speed / (1024 * 1024)).toFixed(1)} MB/s`;
            } else if (speed >= 1024) {
              speedStr = `${(speed / 1024).toFixed(1)} KB/s`;
            } else {
              speedStr = `${speed.toFixed(0)} B/s`;
            }
            setDownloadSpeed(speedStr);
            
            lastBytesRef.current = totalBytesWritten;
            lastTimeRef.current = now;
          }
          
          console.log(`Download progress: ${(fraction * 100).toFixed(1)}%`);
        }
      );

      const downloadResult = await downloadResumable.downloadAsync() as FileSystemDownloadResult | undefined;

      if (!downloadResult || (downloadResult.status !== 0 && (downloadResult.status < 200 || downloadResult.status >= 300))) {
        throw new Error(`Download failed with status: ${downloadResult?.status}`);
      }

      const totalDownloadTime = ((Date.now() - downloadStartTimeRef.current) / 1000).toFixed(1);
      tLog(`Download complete in ${totalDownloadTime}s, extracting...`);
      setDownloadSpeed(`Done in ${totalDownloadTime}s`);
      setDownloadProgress({ models: 0.85 });

      // Extract zip to parent directory
      // Default zip contains 'melo-tts-models' folder
      // Custom zip contains 'default_export' folder
      // We'll extract and then move files to the source-specific directory
      const parentDir = Paths.document.uri;
      await unzip(zipPath, parentDir);

      tLog("Extraction complete!");
      setDownloadProgress({ models: 0.90 });

      // Determine source folder names based on zip contents
      const possibleSourceFolders = [
        { dir: new Directory(Paths.document, "default_export"), name: "default_export" },
        { dir: new Directory(Paths.document, "melo-tts-models"), name: "melo-tts-models" },
      ];
      
      const filesToMove = ["model_int8.onnx", "model_fp16.onnx", "model_mixed.onnx", "model.onnx", "tokens.txt", "lexicon.txt", "tts_config.json"];
      
      // Find which folder the zip extracted to and move files to target directory
      for (const { dir: sourceDir, name: folderName } of possibleSourceFolders) {
        try {
          if (sourceDir.exists) {
            tLog(`Found '${folderName}' folder, moving files to ${source} directory...`);
            
            for (const filename of filesToMove) {
              try {
                const srcFile = new File(sourceDir, filename);
                const destFile = new File(directory, filename);
                
                if (srcFile.info().exists) {
                  // Delete destination if it exists
                  try {
                    if (destFile.info().exists) {
                      destFile.delete();
                    }
                  } catch (e) { /* ignore */ }
                  
                  // Move file
                  srcFile.move(destFile);
                  tLog(`Moved: ${filename}`);
                }
              } catch (e) {
                console.warn(`Failed to move ${filename}:`, e);
              }
            }
            
            // Clean up the extracted folder
            try {
              sourceDir.delete();
              tLog(`Cleaned up '${folderName}' folder`);
            } catch (e) {
              console.warn(`Failed to delete ${folderName} folder:`, e);
            }
            
            break; // Found and processed the source folder
          }
        } catch (e) {
          // Folder doesn't exist, try next one
        }
      }

      setDownloadProgress({ models: 0.95 });

      // Clean up zip file
      try {
        const zipFile = new File(zipPath);
        if (zipFile.info().exists) {
          zipFile.delete();
          console.log("Cleaned up zip file");
        }
      } catch (e) {
        console.warn("Failed to clean up zip file:", e);
      }

      // List what's in the directory after extraction
      console.log("Model directory contents after extraction:");
      try {
        const contents = directory.list();
        contents.forEach(item => console.log(`  - ${item}`));
      } catch (e) {
        console.log("  (error listing)");
      }

      setDownloadProgress({ models: 1 });

      // Verify extraction - check for any model file
      const modelFilesAfter = [
        new File(directory, "model_int8.onnx"),
        new File(directory, "model_fp16.onnx"),
        new File(directory, "model_mixed.onnx"),
        new File(directory, "model.onnx"),
      ];
      
      const hasAnyModelAfter = modelFilesAfter.some(f => {
        try { return f.info().exists; } catch { return false; }
      });
      
      if (!hasAnyModelAfter) {
        throw new Error("Extraction verification failed - no model file found");
      }
      
      tLog(`Model files verified successfully for ${source}`);
      
      // Set current source and refresh states
      setCurrentModelSource(source);
      await refreshModelFiles(source);
      await refreshDownloadedSources();

      return true;
    } catch (error) {
      console.error("Failed to download/extract models:", error);
      setOnnxError(`Failed to download models: ${error}`);
      return false;
    } finally {
      setIsDownloading(false);
    }
  }, [getModelDirectoryForSource, refreshModelFiles, refreshDownloadedSources]);

  // Switch to a different model source (if already downloaded)
  const switchModelSource = useCallback(async (source: ModelSource): Promise<boolean> => {
    const isDownloaded = await checkSourceDownloaded(source);
    
    if (!isDownloaded) {
      tLog(`${source} model not downloaded yet, downloading...`);
      return downloadAndExtractModels(source);
    }
    
    tLog(`Switching to ${source} model source...`);
    setCurrentModelSource(source);
    await refreshModelFiles(source);
    return true;
  }, [checkSourceDownloaded, downloadAndExtractModels, refreshModelFiles]);

  const loadTokens = useCallback(async (tokensPath: string): Promise<Record<string, number>> => {
    const file = new File(tokensPath);
    const content = await file.text();
    const tokenMap: Record<string, number> = {};
    
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parts = trimmed.split(' ');
      if (parts.length >= 2) {
        const symbol = parts[0];
        const id = parseInt(parts[1], 10);
        if (!isNaN(id)) {
          tokenMap[symbol] = id;
        }
      }
    });
    
    console.log(`Loaded ${Object.keys(tokenMap).length} tokens`);
    return tokenMap;
  }, []);

  const loadLexicon = useCallback(async (lexiconPath: string): Promise<Record<string, LexiconEntry>> => {
    const file = new File(lexiconPath);
    const content = await file.text();
    const lexiconMap: Record<string, LexiconEntry> = {};
    
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parts = trimmed.split(' ').filter(p => p.length > 0);
      if (parts.length >= 2) {
        const word = parts[0];
        const rest = parts.slice(1);
        const mid = Math.floor(rest.length / 2);
        const phones = rest.slice(0, mid);
        const tones = rest.slice(mid).map(t => parseInt(t, 10));
        lexiconMap[word] = { phones, tones };
      }
    });
    
    console.log(`Loaded ${Object.keys(lexiconMap).length} lexicon entries`);
    return lexiconMap;
  }, []);

  const loadConfig = useCallback(async (configPath: string): Promise<TTSConfig> => {
    const file = new File(configPath);
    const content = await file.text();
    const configData = JSON.parse(content) as TTSConfig;
    console.log("Loaded TTS config:", configData);
    return configData;
  }, []);

  const downloadModel = useCallback(
    async (model: TTSModel) => {
      const directory = await getModelDirectory();
      const file = new File(directory, model.filename);

      const updateModelFileInfo = () => {
        try {
          const stats = file.info();
          if (!stats.exists) throw new Error("File not found");
          setModelFiles((prev) => ({
            ...prev,
            [model.id]: {
              path: file.uri,
              size: Number(stats.size) || 0,
            },
          }));
        } catch (statError) {
          console.warn(`Failed to stat model file ${model.id}:`, statError);
        }
      };

      // Check if file already exists
      let existingInfo;
      try {
        existingInfo = file.info();
      } catch (infoError) {
        existingInfo = { exists: false };
      }
      
      if (existingInfo.exists) {
        console.log(`Model ${model.id} already exists at ${file.uri}`);
        updateModelFileInfo();
        return file.uri;
      }

      // If no URL provided, model must be manually placed
      if (!model.url) {
        throw new Error(
          `Model file ${model.filename} not found. Please place the model files in the melo-tts-models directory.`
        );
      }

      setIsDownloading(true);
      console.log(`Downloading model ${model.id} from ${model.url}`);

      try {
        const downloadResumable = createDownloadResumable(
          model.url,
          file.uri,
          undefined,
          (progressData: DownloadProgressData) => {
            const { totalBytesWritten, totalBytesExpectedToWrite } = progressData;
            const fraction =
              totalBytesExpectedToWrite > 0
                ? totalBytesWritten / totalBytesExpectedToWrite
                : 0;
            setDownloadProgress((prev) => ({
              ...prev,
              [model.id]: fraction,
            }));
          }
        );

        const downloadResult = (await downloadResumable.downloadAsync()) as
          | FileSystemDownloadResult
          | undefined;

        if (
          downloadResult &&
          (downloadResult.status === 0 ||
            (downloadResult.status >= 200 && downloadResult.status < 300))
        ) {
          console.log(`Successfully downloaded model ${model.id}`);
          updateModelFileInfo();
          setDownloadProgress((prev) => ({ ...prev, [model.id]: 1 }));
          return file.uri;
        } else {
          throw new Error(`Download failed with status: ${downloadResult?.status}`);
        }
      } catch (error) {
        console.error(`Error downloading model ${model.id}:`, error);
        throw error;
      } finally {
        setIsDownloading(false);
      }
    },
    [getModelDirectory]
  );

  const initializeModel = useCallback(
    async (modelId: string, sourceOverride?: ModelSource) => {
      const model = TTS_MODELS.find((m) => m.id === modelId);
      if (!model) throw new Error("Invalid model selected");

      try {
        setIsInitializingModel(true);
        setOnnxError(null);
        const targetSource = sourceOverride ?? currentModelSource;
        tLog(`Initializing TTS model: ${model.label} from source: ${targetSource}`);

        const directory = await getModelDirectoryForSource(targetSource);
        
        // Get model file path from the correct directory
        const modelFile = new File(directory, model.filename);
        if (!modelFile.info().exists) {
          throw new Error(`Model file ${model.filename} not found in ${targetSource} directory. Please download the models first.`);
        }
        const modelPath = modelFile.uri;
        tLog(`Using model file: ${modelPath}`);
        
        // Load tokens.txt
        const tokensFile = new File(directory, "tokens.txt");
        if (!tokensFile.info().exists) {
          throw new Error("tokens.txt not found in melo-tts-models directory");
        }
        const loadedTokens = await loadTokens(tokensFile.uri);
        setTokens(loadedTokens);
        
        // Load lexicon.txt
        const lexiconFile = new File(directory, "lexicon.txt");
        if (!lexiconFile.info().exists) {
          throw new Error("lexicon.txt not found in melo-tts-models directory");
        }
        const loadedLexicon = await loadLexicon(lexiconFile.uri);
        setLexicon(loadedLexicon);
        
        // Load tts_config.json
        const configFile = new File(directory, "tts_config.json");
        if (!configFile.info().exists) {
          throw new Error("tts_config.json not found in melo-tts-models directory");
        }
        const loadedConfig = await loadConfig(configFile.uri);
        setConfig(loadedConfig);
        
        // Initialize ONNX session with hardware acceleration
        // - iOS: CoreML for Neural Engine acceleration
        // - Android: NNAPI for NPU/GPU acceleration (Hexagon NPU on Snapdragon)
        tLog("=== TTS ONNX Session Initialization ===");
        tLog("Model path:", modelPath);
        tLog("Platform:", Platform.OS);
        
        // Define execution providers based on platform
        const executionProviders = Platform.OS === 'ios' 
          ? ['coreml', 'xnnpack', 'cpu'] as const
          : ['nnapi', 'xnnpack', 'cpu'] as const;
        
        tLog("Requested execution providers:", executionProviders);
        tLog("Expected hardware acceleration:");
        if (Platform.OS === 'ios') {
          tLog("  - CoreML → Apple Neural Engine (ANE)");
        } else {
          tLog("  - NNAPI → Hexagon NPU (Snapdragon) / GPU");
        }
        
        tLog("Creating ONNX session...");
        const sessionStartTime = Date.now();
        const session = await InferenceSession.create(modelPath, {
          executionProviders: [...executionProviders],
        });
        const sessionLoadTime = Date.now() - sessionStartTime;
        
        sessionRef.current = session;
        
        tLog(`Session created in ${sessionLoadTime}ms`);
        tLog("Session input names:", session.inputNames);
        tLog("Session output names:", session.outputNames);
        tLog("=== TTS Session Ready ===");
        
        setCurrentModelId(modelId);
        tLog(`TTS model initialized: ${model.label}`);
        
        return { session, tokens: loadedTokens, lexicon: loadedLexicon, config: loadedConfig };
      } catch (error) {
        console.error("Model initialization error:", error);
        setOnnxError(`Failed to initialize: ${error}`);
        throw error;
      } finally {
        setIsInitializingModel(false);
      }
    },
    [getModelDirectoryForSource, currentModelSource, loadTokens, loadLexicon, loadConfig]
  );

  // Simple G2P fallback for unknown words
  const simpleG2P = useCallback((word: string, toneStart: number): { phones: string[]; tones: number[] } => {
    const phones: string[] = [];
    const tones: number[] = [];
    let i = 0;
    const lowerWord = word.toLowerCase();
    
    while (i < lowerWord.length) {
      // Try 2-letter combinations first
      if (i < lowerWord.length - 1) {
        const digraph = lowerWord.slice(i, i + 2);
        if (LETTER_TO_PHONE[digraph]) {
          for (const p of LETTER_TO_PHONE[digraph]) {
            phones.push(p);
            tones.push(toneStart);
          }
          i += 2;
          continue;
        }
      }
      
      // Single letter
      const letter = lowerWord[i];
      if (LETTER_TO_PHONE[letter]) {
        for (const p of LETTER_TO_PHONE[letter]) {
          phones.push(p);
          tones.push(toneStart);
        }
      }
      i++;
    }
    
    return { phones, tones };
  }, []);

  const isPunctuation = useCallback((word: string): boolean => {
    return /^[.,!?;:'"()\-]$/.test(word);
  }, []);

  const textToTokens = useCallback((
    text: string,
    tokenMap: Record<string, number>,
    lexiconMap: Record<string, LexiconEntry>,
    ttsConfig: TTSConfig
  ): { phones: number[]; tones: number[] } => {
    const words = text.toLowerCase().match(/[\w']+|[.,!?;]/g) || [];
    const phoneIds: number[] = [];
    const toneIds: number[] = [];
    const toneStart = ttsConfig.tone_start;
    
    for (const word of words) {
      let result: { phones: string[]; tones: number[] } | null = null;
      
      // 1. Try lexicon first
      if (lexiconMap[word]) {
        const entry = lexiconMap[word];
        result = { phones: entry.phones, tones: entry.tones };
      }
      // 2. Handle punctuation
      else if (isPunctuation(word)) {
        if (tokenMap[word] !== undefined) {
          phoneIds.push(tokenMap[word]);
          toneIds.push(0);
        }
        continue;
      }
      // 3. Fallback to simple G2P
      else {
        result = simpleG2P(word, toneStart);
      }
      
      // Add phones if found
      if (result) {
        for (let i = 0; i < result.phones.length; i++) {
          const phone = result.phones[i];
          if (tokenMap[phone] !== undefined) {
            phoneIds.push(tokenMap[phone]);
            toneIds.push(result.tones[i] || toneStart);
          }
        }
      }
    }
    
    // Add blanks between phonemes if config says so
    if (ttsConfig.add_blank) {
      const phonesWithBlanks = [0];
      const tonesWithBlanks = [0];
      for (let i = 0; i < phoneIds.length; i++) {
        phonesWithBlanks.push(phoneIds[i]);
        tonesWithBlanks.push(toneIds[i]);
        phonesWithBlanks.push(0);
        tonesWithBlanks.push(0);
      }
      return { phones: phonesWithBlanks, tones: tonesWithBlanks };
    }
    
    return { phones: phoneIds, tones: toneIds };
  }, [isPunctuation, simpleG2P]);

  const float32ToWav = useCallback((audioData: Float32Array, sampleRate: number): string => {
    const numSamples = audioData.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };
    
    // WAV header
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    
    // Audio data - convert float32 [-1, 1] to int16
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.max(-1, Math.min(1, audioData[i]));
      view.setInt16(44 + i * 2, sample * 0x7FFF, true);
    }
    
    // Convert to base64
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }, []);

  const synthesize = useCallback(async (
    text: string,
    options: {
      speakerId?: number;
      noiseScale?: number;
      lengthScale?: number;
      noiseScaleW?: number;
    } = {}
  ): Promise<{ audio: Float32Array; sampleRate: number }> => {
    if (!sessionRef.current || !config) {
      throw new Error("TTS model not initialized");
    }
    
    const {
      speakerId = 0,
      noiseScale = 0.6,
      lengthScale = 1.0,
      noiseScaleW = 0.8,
    } = options;
    
    // Convert text to tokens
    const { phones, tones } = textToTokens(text, tokens, lexicon, config);
    const seqLen = phones.length;
    
    if (seqLen === 0) {
      throw new Error("No valid phonemes generated from text");
    }
    
    tLog(`Synthesizing: "${text}" -> ${seqLen} tokens`);
    
    // Create input tensors using onnxruntime-react-native Tensor
    const feeds = {
      x: new Tensor('int64', BigInt64Array.from(phones.map(BigInt)), [1, seqLen]),
      x_lengths: new Tensor('int64', BigInt64Array.from([BigInt(seqLen)]), [1]),
      tones: new Tensor('int64', BigInt64Array.from(tones.map(BigInt)), [1, seqLen]),
      sid: new Tensor('int64', BigInt64Array.from([BigInt(speakerId)]), [1]),
      noise_scale: new Tensor('float32', Float32Array.from([noiseScale]), [1]),
      length_scale: new Tensor('float32', Float32Array.from([lengthScale]), [1]),
      noise_scale_w: new Tensor('float32', Float32Array.from([noiseScaleW]), [1]),
    };
    
    // Run inference with timing
    const inferenceStart = Date.now();
    const results = await sessionRef.current.run(feeds);
    const inferenceEnd = Date.now();
    const inferenceTimeMs = inferenceEnd - inferenceStart;
    
    // Get audio data - output shape is [1, 1, samples]
    const audioData = results.y.data as Float32Array;
    
    // Calculate audio duration
    const audioDurationSec = audioData.length / config.sample_rate;
    
    // Calculate real-time factor (RTF) - lower is better, <1 means faster than real-time
    const rtf = (inferenceTimeMs / 1000) / audioDurationSec;
    
    // Store timing info
    setLastInferenceTime(inferenceTimeMs);
    setLastAudioDuration(audioDurationSec);
    
    // Log detailed performance info
    tLog("=== TTS Inference Performance ===");
    tLog(`Platform: ${Platform.OS}`);
    tLog(`Expected accelerator: ${Platform.OS === 'ios' ? 'CoreML/ANE' : 'NNAPI/Hexagon NPU'}`);
    tLog(`Input tokens: ${seqLen}`);
    tLog(`Inference time: ${inferenceTimeMs}ms`);
    tLog(`Audio duration: ${audioDurationSec.toFixed(2)}s (${audioData.length} samples)`);
    tLog(`Real-time factor (RTF): ${rtf.toFixed(3)}`);
    
    // Performance interpretation
    if (rtf < 0.5) {
      tLog("✅ EXCELLENT - Hardware acceleration likely working (NPU/ANE)");
    } else if (rtf < 1.0) {
      tLog("✅ GOOD - Faster than real-time, may be using XNNPACK or partial NPU");
    } else if (rtf < 2.0) {
      tLog("⚠️ MODERATE - Likely using XNNPACK CPU optimization");
    } else {
      tLog("❌ SLOW - Likely falling back to basic CPU, NPU not engaged");
    }
    tLog("=================================");
    
    return {
      audio: audioData,
      sampleRate: config.sample_rate,
    };
  }, [config, tokens, lexicon, textToTokens]);

  const synthesizeToFile = useCallback(async (
    text: string,
    outputPath: string,
    options: {
      speakerId?: number;
      noiseScale?: number;
      lengthScale?: number;
      noiseScaleW?: number;
    } = {}
  ): Promise<string> => {
    setIsSynthesizing(true);
    try {
      const { audio, sampleRate } = await synthesize(text, options);
      
      // Convert to WAV
      const wavBase64 = float32ToWav(audio, sampleRate);
      
      // Write file
      const file = new File(outputPath);
      const directory = file.parentDirectory;
      if (directory && !directory.exists) {
        directory.create({ intermediates: true });
      }
      
      // Write base64 data
      await writeAsStringAsync(outputPath, wavBase64, { encoding: EncodingType.Base64 });
      
      tLog(`Audio saved to: ${outputPath}`);
      return outputPath;
    } finally {
      setIsSynthesizing(false);
    }
  }, [synthesize, float32ToWav]);

  const playAudio = useCallback(async (filePath: string, options?: { rate?: number }) => {
    try {
      // Stop any existing playback
      if (audioPlayerRef.current) {
        audioPlayerRef.current.remove();
        audioPlayerRef.current = null;
      }
      
      // Create and play audio using expo-audio AudioPlayer
      const player = new AudioModule.AudioPlayer({ uri: filePath }, 500, false);
      audioPlayerRef.current = player;
      
      // Set playback rate if specified (done at native level, zero latency overhead)
      if (options?.rate && options.rate !== 1.0) {
        player.setPlaybackRate(options.rate, 'high');
        tLog(`Audio playback started at ${options.rate}x speed`);
      } else {
        tLog("Audio playback started");
      }
      
      player.play();
    } catch (error) {
      console.error("Audio playback error:", error);
      throw error;
    }
  }, []);

  const stopAudio = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.remove();
      audioPlayerRef.current = null;
      tLog("Audio playback stopped");
    }
  }, []);

  const speakText = useCallback(async (
    text: string,
    options: {
      speakerId?: number;
      noiseScale?: number;
      lengthScale?: number;
      noiseScaleW?: number;
      /** Playback rate (0.5 to 2.0, default 1.0). Applied at native level with zero latency. */
      playbackRate?: number;
    } = {}
  ) => {
    const directory = await getModelDirectory();
    const outputPath = new File(directory, `speech_${Date.now()}.wav`).uri;
    
    await synthesizeToFile(text, outputPath, options);
    await playAudio(outputPath, { rate: options.playbackRate });
    
    return outputPath;
  }, [getModelDirectory, synthesizeToFile, playAudio]);

  const resetModel = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current = null;
    }
    stopAudio();
    setTokens({});
    setLexicon({});
    setConfig(null);
    setCurrentModelId(null);
    setOnnxError(null);
    console.log("TTS model reset");
  }, [stopAudio]);

  const getModelById = useCallback((modelId: string) => {
    return TTS_MODELS.find((m) => m.id === modelId);
  }, []);

  const getCurrentModel = useCallback(() => {
    return currentModelId ? getModelById(currentModelId) : null;
  }, [currentModelId, getModelById]);

  const isModelDownloaded = useCallback((modelId: string) => {
    return modelFiles[modelId] !== undefined;
  }, [modelFiles]);

  const getDownloadProgress = useCallback((modelId: string) => {
    return downloadProgress[modelId] || 0;
  }, [downloadProgress]);

  const isReady = useCallback(() => {
    return sessionRef.current !== null && config !== null && !onnxError;
  }, [config, onnxError]);

  const checkOnnxAvailability = useCallback(async () => {
    try {
      // Attempt to create a dummy session or just ensure the module is loaded
      // For direct import, simply checking if InferenceSession is available is enough
      if (typeof InferenceSession.create === 'function') {
        setOnnxError(null);
        return true;
      }
      throw new Error("InferenceSession.create is not a function.");
    } catch (error) {
      const errorMsg = `${error}`;
      setOnnxError(errorMsg);
      return false;
    }
  }, []);

  // Load existing models on mount
  useEffect(() => {
    let isMounted = true;

    const loadExistingModels = async () => {
      try {
        const directory = await getModelDirectory();
        const entries = await Promise.all(
          TTS_MODELS.map(async (model) => {
            const file = new File(directory, model.filename);
            try {
              const fileInfo = file.info();
              if (!fileInfo.exists) return null;

              return {
                id: model.id,
                info: {
                  path: file.uri,
                  size: Number(fileInfo.size) || 0,
                },
              };
            } catch (statError) {
              return null;
            }
          })
        );

        if (!isMounted) return;

        const fileMap: Record<string, ModelFileInfo> = {};
        entries.forEach((entry) => {
          if (entry) {
            fileMap[entry.id] = entry.info;
          }
        });

        if (Object.keys(fileMap).length > 0) {
          setModelFiles((prev) => ({ ...prev, ...fileMap }));
        }
      } catch (error) {
        console.warn("Failed to load existing TTS models:", error);
      }
    };

    loadExistingModels();
    // Also check which sources have been downloaded
    refreshDownloadedSources();

    return () => {
      isMounted = false;
    };
  }, [getModelDirectory, refreshDownloadedSources]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAudio();
    };
  }, [stopAudio]);

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
    initializeModel,
    resetModel,
    synthesize,
    synthesizeToFile,
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
  };
}
