import React, { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, YAxis } from "recharts";
import { Download, HelpCircle, Play, Search, Star } from "lucide-react";
import archive from "../sound-presets.archive.json";
import { Button } from "./components/ui/button";
import { ChartContainer } from "./components/ui/chart";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { ensureAudioContext, playPreset } from "./lib/soundEngine";
import { downloadPresetMp3 } from "./lib/downloadAudio";
import { cn } from "./lib/utils";

function formatDuration(seconds) {
  return `${Number(seconds).toFixed(2)}s`;
}

const FAVORITES_STORAGE_KEY = "soft-ai-sound-favorites";

function readStoredFavorites() {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    const values = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(values) ? values.filter(Number.isInteger) : []);
  } catch {
    return new Set();
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function semitoneToFrequency(base, semitone) {
  return base * Math.pow(2, semitone / 12);
}

function envelopeAt(localTime, duration, attack, shape = "tone") {
  if (localTime < 0 || localTime > duration) {
    return 0;
  }

  const safeAttack = Math.max(0.006, Math.min(attack || 0.08, duration * 0.75));
  if (localTime <= safeAttack) {
    return localTime / safeAttack;
  }

  const releaseProgress = clamp((localTime - safeAttack) / Math.max(0.001, duration - safeAttack), 0, 1);
  const decayPower = shape === "bell" ? 2.6 : shape === "noise" ? 1.2 : 1.65;
  return Math.pow(1 - releaseProgress, decayPower);
}

function getLayerEvents(layer, presetStart = 0) {
  const start = presetStart + (layer.start || 0);
  const events = [];

  if (layer.type === "twoTone") {
    events.push({ start, duration: layer.duration, attack: layer.attack || 0.12, volume: layer.volume || 0.08, frequency: layer.freqs[0], shape: "tone" });
    events.push({
      start: start + (layer.delay || 0.12),
      duration: Math.max(0.1, layer.duration - (layer.delay || 0.12)),
      attack: Math.min(0.14, layer.attack || 0.12),
      volume: layer.volume || 0.08,
      frequency: layer.freqs[1],
      shape: "tone"
    });
    return events;
  }

  if (layer.type === "tones" || layer.type === "bell") {
    const freqs = layer.freqs || [];
    freqs.forEach((frequency, noteIndex) => {
      events.push({
        start: start + noteIndex * (layer.stagger || 0),
        duration: Math.max(0.12, (layer.duration || 1.5) - noteIndex * (layer.stagger || 0)),
        attack: layer.attack ?? (layer.type === "bell" ? 0.014 : 0.12),
        volume: (layer.volume || 0.08) / Math.sqrt(Math.max(1, freqs.length)),
        frequency,
        shape: layer.type === "bell" ? "bell" : "tone"
      });
    });
    return events;
  }

  if (layer.type === "arpeggio") {
    const freqs = layer.freqs || (layer.steps || []).map((step) => semitoneToFrequency(layer.base || 440, step));
    freqs.forEach((frequency, noteIndex) => {
      events.push({
        start: start + noteIndex * (layer.step || 0.1),
        duration: Math.min(0.62, Math.max(0.16, (layer.duration || 1.4) - noteIndex * (layer.step || 0.1))),
        attack: 0.018,
        volume: layer.volume || 0.06,
        frequency,
        shape: "bell"
      });
    });
    return events;
  }

  if (layer.type === "noise") {
    events.push({
      start,
      duration: layer.duration || 1.8,
      attack: layer.attack || 0.16,
      volume: layer.volume || 0.05,
      frequency: layer.bandpass || layer.lowpass || layer.highpass || 900,
      shape: "noise"
    });
    return events;
  }

  if (layer.type === "sweep") {
    events.push({
      start,
      duration: layer.duration || 1.8,
      attack: layer.attack || 0.2,
      volume: layer.volume || 0.08,
      frequency: layer.freqs?.[0] || 90,
      shape: "tone"
    });
    return events;
  }

  if (layer.type === "fm") {
    const freqs = layer.freqs || [];
    freqs.forEach((frequency, noteIndex) => {
      events.push({
        start: start + noteIndex * (layer.stagger || 0),
        duration: Math.max(0.18, (layer.duration || 1.8) - noteIndex * (layer.stagger || 0)),
        attack: layer.attack || 0.08,
        volume: (layer.volume || 0.06) / Math.sqrt(Math.max(1, freqs.length)),
        frequency: frequency * (layer.modRatio || 2),
        shape: "tone"
      });
    });
  }

  return events;
}

function getPresetEvents(preset) {
  if (preset.layers) {
    return preset.layers.flatMap((layer) => getLayerEvents(layer));
  }

  return [
    { start: 0, duration: preset.duration, attack: preset.attack, volume: preset.master * 1.4, frequency: preset.base, shape: "tone" },
    { start: preset.topDelay || 0.15, duration: preset.duration - (preset.topDelay || 0.15), attack: 0.13, volume: preset.master, frequency: preset.upper, shape: "tone" },
    { start: preset.chimeDelay || 0.25, duration: 0.78, attack: 0.055, volume: preset.chimeGain || 0.05, frequency: preset.chime, shape: "bell" },
    { start: 0, duration: preset.duration + 0.08, attack: 0.18, volume: preset.noiseGain || 0.01, frequency: preset.filter || 900, shape: "noise" }
  ];
}

function pseudoNoise(time, frequency) {
  return Math.sin(time * frequency * 0.073 + Math.sin(time * 31.7) * 4.3);
}

function sampleWaveform(events, time) {
  return events.reduce((sum, event) => {
    const local = time - event.start;
    const env = envelopeAt(local, event.duration, event.attack, event.shape);
    if (env <= 0) {
      return sum;
    }

    const oscillator = event.shape === "noise"
      ? pseudoNoise(time, event.frequency)
      : Math.sin(Math.PI * 2 * event.frequency * time);
    return sum + oscillator * env * event.volume;
  }, 0);
}

function getChartData(preset) {
  const duration = preset.duration || 1.5;
  const events = getPresetEvents(preset);
  const points = 96;
  const samplesPerPoint = 6;
  const raw = Array.from({ length: points }, (_, pointIndex) => {
    const windowStart = (pointIndex / points) * duration;
    let peak = 0;

    for (let sampleIndex = 0; sampleIndex < samplesPerPoint; sampleIndex += 1) {
      const time = windowStart + (sampleIndex / samplesPerPoint) * (duration / points);
      peak = Math.max(peak, Math.abs(sampleWaveform(events, time)));
    }

    return peak;
  });

  const maxPeak = Math.max(0.0001, ...raw);
  return raw.map((peak, index) => {
    const normalized = clamp(peak / maxPeak, 0, 1);
    const amplitude = Math.max(4, normalized * 42);
    return {
      index,
      upper: 50 + amplitude,
      lower: 50 - amplitude
    };
  });
}

function SoundRow({ preset, index, isFavorite, isPlaying, progress, isDownloading, onPlay, onToggleFavorite, onDownload }) {
  const chartData = useMemo(() => getChartData(preset), [preset]);
  const descriptionButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 md:h-9 md:w-9" aria-label={`${preset.name} 설명`}>
          <HelpCircle className="h-4 w-4 text-muted-foreground" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{preset.desc}</p>
      </TooltipContent>
    </Tooltip>
  );
  const favoriteButton = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={`${preset.name} 즐겨찾기`}
      className="h-8 w-8 md:h-9 md:w-9"
      onClick={() => onToggleFavorite(index)}
    >
      <Star className={cn("h-4 w-4 text-zinc-700", isFavorite && "fill-zinc-800 text-zinc-800")} />
    </Button>
  );
  const downloadButton = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={`${preset.name} MP3 다운로드`}
      className="h-8 w-8 md:h-9 md:w-9"
      disabled={isDownloading}
      onClick={() => onDownload(index)}
    >
      <Download className={cn("h-4 w-4 text-zinc-700", isDownloading && "animate-pulse")} />
    </Button>
  );

  return (
    <div
      className={cn(
        "relative grid w-full max-w-full grid-cols-[2.25rem_minmax(0,1fr)_2rem_2rem_2rem] items-center gap-x-2 gap-y-2 overflow-hidden rounded-lg border bg-card px-3 py-3 shadow-sm transition-colors md:flex md:flex-nowrap md:gap-3",
        isPlaying && "border-zinc-400 bg-zinc-50"
      )}
    >
      <Button
        type="button"
        size="icon"
        variant={isPlaying ? "default" : "outline"}
        className="col-start-1 row-start-1 h-9 w-9 shrink-0 rounded-full md:order-1"
        aria-label={`${preset.name} 재생`}
        onClick={() => onPlay(index)}
      >
        <Play className="h-4 w-4 fill-current" />
      </Button>

      <div className="col-start-2 row-start-1 min-w-0 md:order-2 md:flex-1">
        <div className="truncate text-sm font-semibold text-slate-950">{preset.name}</div>
        <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
          <span className="rounded-full border bg-white px-2 py-0.5">{preset.pitch || "Generated"}</span>
          <span className="rounded-full border bg-white px-2 py-0.5">{preset.layer || "Soft AI"}</span>
        </div>
      </div>

      <div className="col-start-3 row-start-1 shrink-0 md:order-3">{descriptionButton}</div>

      <div className="col-span-full row-start-2 flex w-full min-w-0 items-center gap-3 md:order-4 md:w-[360px] md:shrink-0">
        <span className="w-14 shrink-0 text-right text-sm font-medium text-slate-600">{formatDuration(preset.duration)}</span>
        <div className="relative h-12 min-w-0 flex-1 overflow-hidden rounded-md bg-slate-100">
          <ChartContainer config={{ wave: { color: isPlaying ? "#2563eb" : "#60a5fa" } }} className="h-full w-full">
            <AreaChart data={chartData} margin={{ left: 0, right: 0, top: 4, bottom: 4 }}>
              <YAxis hide domain={[0, 100]} />
              <defs>
                <linearGradient id={`wave-${index}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-wave)" stopOpacity={0.36} />
                  <stop offset="50%" stopColor="var(--color-wave)" stopOpacity={0.1} />
                  <stop offset="95%" stopColor="var(--color-wave)" stopOpacity={0.36} />
                </linearGradient>
              </defs>
              <Area dataKey="upper" type="basis" stroke="var(--color-wave)" strokeWidth={1.5} fill={`url(#wave-${index})`} baseValue={50} isAnimationActive={false} dot={false} />
              <Area dataKey="lower" type="basis" stroke="var(--color-wave)" strokeWidth={1.5} fill={`url(#wave-${index})`} baseValue={50} isAnimationActive={false} dot={false} />
            </AreaChart>
          </ChartContainer>
          {isPlaying ? (
            <div
              className="pointer-events-none absolute bottom-1 top-1 w-0.5 rounded-full bg-blue-700 shadow-[0_0_0_3px_rgba(37,99,235,0.14)]"
              style={{ left: `${Math.min(99, Math.max(1, progress * 100))}%` }}
            />
          ) : null}
        </div>
      </div>

      <div className="col-start-4 row-start-1 shrink-0 md:order-5">{favoriteButton}</div>
      <div className="col-start-5 row-start-1 shrink-0 md:order-6">{downloadButton}</div>
    </div>
  );
}

export default function App() {
  const [favorites, setFavorites] = useState(readStoredFavorites);
  const [playback, setPlayback] = useState({ index: null, startedAt: 0, duration: 0, progress: 0 });
  const [downloadingIndex, setDownloadingIndex] = useState(null);
  const [query, setQuery] = useState("");
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  const presets = archive.presets;
  const visiblePresets = useMemo(() => {
    const value = query.trim().toLowerCase();
    return presets
      .map((preset, index) => ({ preset, index }))
      .filter(({ preset, index }) => {
        const matchesFavorite = !showFavoritesOnly || favorites.has(index);
        const matchesQuery = !value || `${preset.name} ${preset.desc} ${preset.pitch} ${preset.layer}`.toLowerCase().includes(value);
        return matchesFavorite && matchesQuery;
      });
  }, [favorites, presets, query, showFavoritesOnly]);

  useEffect(() => {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
  }, [favorites]);

  useEffect(() => {
    if (playback.index === null) {
      return undefined;
    }

    let frameId = 0;
    const tick = () => {
      const elapsed = performance.now() - playback.startedAt;
      const progress = Math.min(1, elapsed / playback.duration);
      setPlayback((current) => (current.index === playback.index ? { ...current, progress } : current));

      if (progress < 1) {
        frameId = requestAnimationFrame(tick);
      } else {
        setPlayback((current) => (current.index === playback.index ? { index: null, startedAt: 0, duration: 0, progress: 0 } : current));
      }
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [playback.index, playback.startedAt, playback.duration]);

  async function handlePlay(index) {
    await ensureAudioContext();
    const preset = presets[index];
    playPreset(preset);
    setPlayback({
      index,
      startedAt: performance.now(),
      duration: Math.max(600, preset.duration * 1000),
      progress: 0
    });
  }

  function handleToggleFavorite(index) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  async function handleDownload(index) {
    setDownloadingIndex(index);
    try {
      await downloadPresetMp3(presets[index], index);
    } finally {
      setDownloadingIndex(null);
    }
  }

  return (
    <TooltipProvider delayDuration={180}>
      <main className="min-h-screen overflow-x-hidden bg-zinc-50 px-4 py-8">
        <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6">
          <header className="flex min-w-0 justify-end">
            <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:items-end">
              <div className="flex w-full min-w-0 gap-2 sm:w-auto">
                <div className="relative min-w-0 flex-1 sm:w-80">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search sounds"
                    className="h-10 w-full rounded-md border bg-white pl-9 pr-3 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                </div>
                <Button
                  type="button"
                  variant={showFavoritesOnly ? "default" : "outline"}
                  aria-pressed={showFavoritesOnly}
                  onClick={() => setShowFavoritesOnly((current) => !current)}
                  className="h-10 shrink-0 rounded-md px-3"
                >
                  <Star className={cn("h-4 w-4", showFavoritesOnly && "fill-current")} />
                  <span className="hidden sm:inline">Favorites</span>
                </Button>
              </div>
              <div className="w-full text-sm text-muted-foreground sm:text-right">
                <span className="font-medium text-slate-700">{presets.length}</span> sounds
                <span className="mx-2 text-slate-300">/</span>
                <span className="font-medium text-slate-700">{favorites.size}</span> favorites selected
              </div>
            </div>
          </header>

          <section className="w-full min-w-0 overflow-hidden rounded-lg border bg-white/80 p-3 shadow-soft backdrop-blur">
            <div className="flex flex-col gap-2">
              {visiblePresets.map(({ preset, index }) => {
                return (
                  <SoundRow
                    key={`${preset.name}-${index}`}
                    preset={preset}
                    index={index}
                    isFavorite={favorites.has(index)}
                    isPlaying={playback.index === index}
                    progress={playback.index === index ? playback.progress : 0}
                    isDownloading={downloadingIndex === index}
                    onPlay={handlePlay}
                    onToggleFavorite={handleToggleFavorite}
                    onDownload={handleDownload}
                  />
                );
              })}
              {visiblePresets.length === 0 ? (
                <div className="rounded-lg border border-dashed bg-white px-4 py-8 text-center text-sm text-muted-foreground">
                  {showFavoritesOnly ? "No favorite sounds match this view." : "No sounds match your search."}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </main>
    </TooltipProvider>
  );
}
