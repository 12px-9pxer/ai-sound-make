import lameScriptUrl from "lamejs/lame.min.js?url";
import { renderPresetBuffer } from "./soundEngine";

let lameLoadPromise = null;

function loadLameEncoder() {
  if (window.lamejs?.Mp3Encoder) {
    return Promise.resolve(window.lamejs);
  }

  if (!lameLoadPromise) {
    lameLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = lameScriptUrl;
      script.async = true;
      script.onload = () => {
        if (window.lamejs?.Mp3Encoder) {
          resolve(window.lamejs);
          return;
        }
        reject(new Error("MP3 encoder failed to initialize."));
      };
      script.onerror = () => reject(new Error("MP3 encoder failed to load."));
      document.head.appendChild(script);
    });
  }

  return lameLoadPromise;
}

function floatTo16BitPcm(float32Array) {
  const output = new Int16Array(float32Array.length);

  for (let index = 0; index < float32Array.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
}

async function encodeMp3(audioBuffer) {
  const lame = await loadLameEncoder();
  const sampleRate = audioBuffer.sampleRate;
  const left = floatTo16BitPcm(audioBuffer.getChannelData(0));
  const right = floatTo16BitPcm(audioBuffer.getChannelData(1));
  const encoder = new lame.Mp3Encoder(2, sampleRate, 128);
  const blockSize = 1152;
  const chunks = [];

  for (let index = 0; index < left.length; index += blockSize) {
    const leftChunk = left.subarray(index, index + blockSize);
    const rightChunk = right.subarray(index, index + blockSize);
    const mp3Buffer = encoder.encodeBuffer(leftChunk, rightChunk);

    if (mp3Buffer.length > 0) {
      chunks.push(mp3Buffer);
    }
  }

  const end = encoder.flush();
  if (end.length > 0) {
    chunks.push(end);
  }

  return new Blob(chunks, { type: "audio/mpeg" });
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadPresetMp3(preset, index) {
  const audioBuffer = await renderPresetBuffer(preset);
  const blob = await encodeMp3(audioBuffer);
  const number = String(index + 1).padStart(2, "0");
  const filename = `${number}-${slugify(preset.name)}.mp3`;
  downloadBlob(blob, filename);
  return filename;
}
