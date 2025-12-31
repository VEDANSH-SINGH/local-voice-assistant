# MeloTTS ONNX - React Native Integration Guide

## Overview

This package contains a MeloTTS text-to-speech model exported to ONNX format for use in React Native applications. The model converts text to natural-sounding speech.

## Files Included

```
onnx_export/
├── model.onnx          # FP32 model (best quality, ~162MB)
├── model_int8.onnx     # INT8 model (fastest, smallest, ~41MB)
├── tokens.txt          # Symbol-to-ID mapping
├── lexicon.txt         # Word-to-phoneme dictionary
└── tts_config.json     # Model configuration
```

### Which Model to Use?

| Model | Size | Speed | Quality | Recommended For |
|-------|------|-------|---------|-----------------|
| `model.onnx` (FP32) | ~162MB | 1x | ⭐⭐⭐⭐⭐ | Best quality, devices with good RAM |
| `model_int8.onnx` | ~41MB | ~3x | ⭐⭐⭐⭐ | Production, faster inference |

**Recommendation**: Start with `model_int8.onnx` for mobile.

---

## Setup

### 1. Install Required Packages

```bash
npm install onnxruntime-react-native react-native-fs react-native-sound cmu-pronouncing-dictionary
# or
yarn add onnxruntime-react-native react-native-fs react-native-sound cmu-pronouncing-dictionary
```

| Package | Purpose |
|---------|---------|
| `onnxruntime-react-native` | Run ONNX model |
| `react-native-fs` | File system access |
| `react-native-sound` | Audio playback |
| `cmu-pronouncing-dictionary` | G2P for unknown words |

### 2. iOS Additional Setup

Add to your `Podfile`:
```ruby
pod 'onnxruntime-react-native', :path => '../node_modules/onnxruntime-react-native'
```

Then run:
```bash
cd ios && pod install
```

### 3. Android Additional Setup

No additional setup needed. ONNX Runtime is automatically linked.

---

## Model Configuration

From `tts_config.json`:

```json
{
  "language": "EN",
  "lang_id": 2,
  "tone_start": 7,
  "sample_rate": 44100,
  "add_blank": true,
  "n_speakers": 1,
  "spk2id": {"avinash": 0}
}
```

**Key values:**
- `sample_rate`: 44100 Hz - Audio output sample rate
- `add_blank`: true - Must add blank tokens between phonemes
- `speaker_id`: 0 - Default speaker

---

## Text Processing Pipeline

The TTS pipeline has 3 steps:

```
Text → Phonemes → Token IDs → Model → Audio
```

### Step 1: Text to Phonemes

Convert English text to phonemes using the lexicon or G2P (Grapheme-to-Phoneme).

**Using Lexicon (lexicon.txt):**
```
hello h eh l ow 7 7 7 7
world w er l d 7 7 7 7
```

Format: `word phone1 phone2 ... tone1 tone2 ...`

### Step 2: Phonemes to Token IDs

Use `tokens.txt` to convert phonemes to integer IDs:
```
_ 0
aa 21
ae 22
ah 23
...
```

### Step 3: Add Blank Tokens

Since `add_blank: true`, insert blank token (0) between each phoneme:
```
Original:  [h, eh, l, ow]  → IDs: [48, 39, 69, 79]
With blanks: [0, 48, 0, 39, 0, 69, 0, 79, 0]
```

---

## Model Inputs/Outputs

### Inputs

| Name | Type | Shape | Description |
|------|------|-------|-------------|
| `x` | int64 | [1, seq_len] | Token IDs |
| `x_lengths` | int64 | [1] | Sequence length |
| `tones` | int64 | [1, seq_len] | Tone IDs (same length as x) |
| `sid` | int64 | [1] | Speaker ID (use 0) |
| `noise_scale` | float32 | [1] | Generation noise (default: 0.6) |
| `length_scale` | float32 | [1] | Speed control (1.0 = normal, 0.8 = faster) |
| `noise_scale_w` | float32 | [1] | Duration noise (default: 0.8) |

### Output

| Name | Type | Shape | Description |
|------|------|-------|-------------|
| `y` | float32 | [1, 1, samples] | Audio waveform (-1.0 to 1.0) |

---

## React Native Implementation

### Basic Example

```javascript
import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import RNFS from 'react-native-fs';
import Sound from 'react-native-sound';

class MeloTTS {
  constructor() {
    this.session = null;
    this.tokens = {};
    this.lexicon = {};
    this.sampleRate = 44100;
  }

  async initialize(modelPath, tokensPath, lexiconPath) {
    // Load ONNX model
    this.session = await InferenceSession.create(modelPath);
    
    // Load tokens
    const tokensContent = await RNFS.readFile(tokensPath, 'utf8');
    tokensContent.split('\n').forEach(line => {
      const [symbol, id] = line.trim().split(' ');
      if (symbol && id) {
        this.tokens[symbol] = parseInt(id);
      }
    });
    
    // Load lexicon
    const lexiconContent = await RNFS.readFile(lexiconPath, 'utf8');
    lexiconContent.split('\n').forEach(line => {
      const parts = line.trim().split(' ');
      if (parts.length >= 2) {
        const word = parts[0];
        const rest = parts.slice(1);
        const mid = rest.length / 2;
        const phones = rest.slice(0, mid);
        const tones = rest.slice(mid).map(t => parseInt(t));
        this.lexicon[word] = { phones, tones };
      }
    });
  }

  textToTokens(text) {
    const words = text.toLowerCase().match(/[\w']+|[.,!?;]/g) || [];
    let phones = [];
    let tones = [];
    
    for (const word of words) {
      if (this.lexicon[word]) {
        const entry = this.lexicon[word];
        for (let i = 0; i < entry.phones.length; i++) {
          const phone = entry.phones[i];
          if (this.tokens[phone] !== undefined) {
            phones.push(this.tokens[phone]);
            tones.push(entry.tones[i]);
          }
        }
      } else {
        // Handle punctuation
        if (this.tokens[word] !== undefined) {
          phones.push(this.tokens[word]);
          tones.push(0);
        }
      }
    }
    
    // Add blanks (token 0) between each phone
    const phonesWithBlanks = [0];
    const tonesWithBlanks = [0];
    for (let i = 0; i < phones.length; i++) {
      phonesWithBlanks.push(phones[i]);
      tonesWithBlanks.push(tones[i]);
      phonesWithBlanks.push(0);
      tonesWithBlanks.push(0);
    }
    
    return { phones: phonesWithBlanks, tones: tonesWithBlanks };
  }

  async synthesize(text, options = {}) {
    const {
      speakerId = 0,
      noiseScale = 0.6,
      lengthScale = 1.0,
      noiseScaleW = 0.8
    } = options;

    // Convert text to tokens
    const { phones, tones } = this.textToTokens(text);
    const seqLen = phones.length;

    // Create input tensors
    const feeds = {
      x: new Tensor('int64', BigInt64Array.from(phones.map(BigInt)), [1, seqLen]),
      x_lengths: new Tensor('int64', BigInt64Array.from([BigInt(seqLen)]), [1]),
      tones: new Tensor('int64', BigInt64Array.from(tones.map(BigInt)), [1, seqLen]),
      sid: new Tensor('int64', BigInt64Array.from([BigInt(speakerId)]), [1]),
      noise_scale: new Tensor('float32', Float32Array.from([noiseScale]), [1]),
      length_scale: new Tensor('float32', Float32Array.from([lengthScale]), [1]),
      noise_scale_w: new Tensor('float32', Float32Array.from([noiseScaleW]), [1]),
    };

    // Run inference
    const results = await this.session.run(feeds);
    
    // Get audio data
    const audioData = results.y.data; // Float32Array
    
    return {
      audio: audioData,
      sampleRate: this.sampleRate
    };
  }

  async synthesizeToFile(text, outputPath, options = {}) {
    const { audio, sampleRate } = await this.synthesize(text, options);
    
    // Convert Float32 audio to WAV file
    const wavBuffer = this.float32ToWav(audio, sampleRate);
    await RNFS.writeFile(outputPath, wavBuffer, 'base64');
    
    return outputPath;
  }

  float32ToWav(audioData, sampleRate) {
    // Convert float32 [-1, 1] to int16
    const numSamples = audioData.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    
    // WAV header
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
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
    
    // Audio data
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
  }
}

export default MeloTTS;
```

### Usage Example

```javascript
import MeloTTS from './MeloTTS';
import Sound from 'react-native-sound';

// Initialize
const tts = new MeloTTS();
await tts.initialize(
  'path/to/model_int8.onnx',
  'path/to/tokens.txt',
  'path/to/lexicon.txt'
);

// Synthesize speech
const outputPath = `${RNFS.CachesDirectoryPath}/speech.wav`;
await tts.synthesizeToFile(
  'Hello, this is a test of the text to speech system.',
  outputPath,
  {
    lengthScale: 1.0,  // 1.0 = normal speed, 0.8 = faster
    noiseScale: 0.6,   // Lower = more robotic, higher = more natural
  }
);

// Play audio
const sound = new Sound(outputPath, '', (error) => {
  if (!error) {
    sound.play();
  }
});
```

---

## Performance Tips

### 1. Model Loading
- Load the model once at app startup
- Keep the session in memory

### 2. Use INT8 for Production
- 3x faster inference
- 4x smaller model size
- Minimal quality difference

### 3. Chunk Long Text
- Split text into sentences
- Process each sentence separately
- Concatenate audio results

### 4. Speed Control
- `lengthScale: 0.8` = 25% faster speech
- `lengthScale: 1.2` = 20% slower speech

---

## Troubleshooting

### "Model not found"
- Ensure model file is bundled with the app
- Check file path is correct

### "Out of memory"
- Use INT8 model instead of FP32
- Process shorter text chunks

### "Audio sounds robotic"
- Increase `noiseScale` (try 0.667)
- Use FP32 model for better quality

### "Words not pronounced correctly"
- Word may not be in lexicon
- You need G2P (grapheme-to-phoneme) - see section below

---

## G2P (Grapheme-to-Phoneme) - IMPORTANT

The `lexicon.txt` only contains ~130k common English words. For words NOT in the lexicon (names, technical terms, new words), you need G2P.

### Option 1: JavaScript G2P Library (Recommended)

Use `cmu-pronouncing-dictionary` + fallback rules:

```bash
npm install cmu-pronouncing-dictionary
```

```javascript
import cmuDict from 'cmu-pronouncing-dictionary';

// CMU dict uses ARPABET phonemes - need to convert to lowercase
const ARPABET_TO_MELO = {
  'AA': 'aa', 'AE': 'ae', 'AH': 'ah', 'AO': 'ao', 'AW': 'aw',
  'AY': 'ay', 'B': 'b', 'CH': 'ch', 'D': 'd', 'DH': 'dh',
  'EH': 'eh', 'ER': 'er', 'EY': 'ey', 'F': 'f', 'G': 'g',
  'HH': 'hh', 'IH': 'ih', 'IY': 'iy', 'JH': 'jh', 'K': 'k',
  'L': 'l', 'M': 'm', 'N': 'n', 'NG': 'ng', 'OW': 'ow',
  'OY': 'oy', 'P': 'p', 'R': 'r', 'S': 's', 'SH': 'sh',
  'T': 't', 'TH': 'th', 'UH': 'uh', 'UW': 'uw', 'V': 'V',
  'W': 'w', 'Y': 'y', 'Z': 'z', 'ZH': 'zh'
};

function g2pWord(word) {
  const upper = word.toUpperCase();
  if (cmuDict[upper]) {
    const arpabet = cmuDict[upper].split(' ');
    const phones = [];
    const tones = [];
    
    for (const phone of arpabet) {
      // Extract stress number (0, 1, 2) if present
      const match = phone.match(/^([A-Z]+)(\d)?$/);
      if (match) {
        const basePhone = match[1];
        const stress = match[2] ? parseInt(match[2]) + 1 : 0;
        
        if (ARPABET_TO_MELO[basePhone]) {
          phones.push(ARPABET_TO_MELO[basePhone]);
          tones.push(stress + 7); // 7 is tone_start for English
        }
      }
    }
    return { phones, tones };
  }
  return null; // Word not found
}
```

### Option 2: Simple Rule-Based Fallback

For unknown words, use basic letter-to-sound rules:

```javascript
const LETTER_TO_PHONE = {
  'a': ['ae'], 'b': ['b'], 'c': ['k'], 'd': ['d'], 'e': ['eh'],
  'f': ['f'], 'g': ['g'], 'h': ['hh'], 'i': ['ih'], 'j': ['jh'],
  'k': ['k'], 'l': ['l'], 'm': ['m'], 'n': ['n'], 'o': ['ow'],
  'p': ['p'], 'q': ['k', 'w'], 'r': ['r'], 's': ['s'], 't': ['t'],
  'u': ['ah'], 'v': ['V'], 'w': ['w'], 'x': ['k', 's'], 'y': ['y'],
  'z': ['z'],
  // Common digraphs
  'th': ['th'], 'sh': ['sh'], 'ch': ['ch'], 'ph': ['f'],
  'wh': ['w'], 'ck': ['k'], 'ng': ['ng'],
};

function simpleG2P(word) {
  const phones = [];
  const tones = [];
  let i = 0;
  word = word.toLowerCase();
  
  while (i < word.length) {
    // Try 2-letter combinations first
    if (i < word.length - 1) {
      const digraph = word.slice(i, i + 2);
      if (LETTER_TO_PHONE[digraph]) {
        for (const p of LETTER_TO_PHONE[digraph]) {
          phones.push(p);
          tones.push(7); // Default tone
        }
        i += 2;
        continue;
      }
    }
    
    // Single letter
    const letter = word[i];
    if (LETTER_TO_PHONE[letter]) {
      for (const p of LETTER_TO_PHONE[letter]) {
        phones.push(p);
        tones.push(7);
      }
    }
    i++;
  }
  
  return { phones, tones };
}
```

### Option 3: Server-Side G2P API

If you need high accuracy, call a server with Python G2P:

```javascript
async function g2pServer(text) {
  const response = await fetch('https://your-api.com/g2p', {
    method: 'POST',
    body: JSON.stringify({ text }),
    headers: { 'Content-Type': 'application/json' }
  });
  return response.json(); // { phones: [...], tones: [...] }
}
```

### Updated textToTokens with G2P

```javascript
textToTokens(text) {
  const words = text.toLowerCase().match(/[\w']+|[.,!?;]/g) || [];
  let phones = [];
  let tones = [];
  
  for (const word of words) {
    let result = null;
    
    // 1. Try lexicon first (fastest)
    if (this.lexicon[word]) {
      const entry = this.lexicon[word];
      result = { phones: entry.phones, tones: entry.tones };
    }
    // 2. Try CMU dictionary G2P
    else if (!this.isPunctuation(word)) {
      result = g2pWord(word);
    }
    // 3. Fallback to simple rules
    if (!result && !this.isPunctuation(word)) {
      result = simpleG2P(word);
    }
    // 4. Handle punctuation
    else if (this.tokens[word] !== undefined) {
      phones.push(this.tokens[word]);
      tones.push(0);
      continue;
    }
    
    // Add phones if found
    if (result) {
      for (let i = 0; i < result.phones.length; i++) {
        const phone = result.phones[i];
        if (this.tokens[phone] !== undefined) {
          phones.push(this.tokens[phone]);
          tones.push(result.tones[i]);
        }
      }
    }
  }
  
  // Add blanks
  const phonesWithBlanks = [0];
  const tonesWithBlanks = [0];
  for (let i = 0; i < phones.length; i++) {
    phonesWithBlanks.push(phones[i]);
    tonesWithBlanks.push(tones[i]);
    phonesWithBlanks.push(0);
    tonesWithBlanks.push(0);
  }
  
  return { phones: phonesWithBlanks, tones: tonesWithBlanks };
}

isPunctuation(word) {
  return /^[.,!?;:'"()-]$/.test(word);
}
```

### Recommendation

1. **For most apps**: Use `lexicon.txt` + `cmu-pronouncing-dictionary` npm package
2. **For names/technical terms**: Add simple rule-based fallback
3. **For production quality**: Consider server-side Python G2P

---

## API Reference

### MeloTTS.initialize(modelPath, tokensPath, lexiconPath)
Load model and vocabulary files.

### MeloTTS.synthesize(text, options)
Convert text to audio.

**Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| speakerId | number | 0 | Speaker voice ID |
| noiseScale | number | 0.6 | Generation randomness |
| lengthScale | number | 1.0 | Speed (lower = faster) |
| noiseScaleW | number | 0.8 | Duration randomness |

**Returns:** `{ audio: Float32Array, sampleRate: number }`

### MeloTTS.synthesizeToFile(text, outputPath, options)
Convert text to WAV file.

**Returns:** File path string

---

## Support

For issues with:
- **Model/Export**: Contact ML team
- **React Native Integration**: Check onnxruntime-react-native docs
- **Audio Playback**: Check react-native-sound docs

