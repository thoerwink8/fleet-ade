import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { MicIcon, PauseIcon, PlayIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { openMicrophone } from "../../speech/browserPcmCapture";
import workletUrl from "../../speech/pcmWorklet.ts?worker&url";
import { VoiceWaveform } from "../chat/VoiceInputPill";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const LOOPBACK_SECONDS = 10;
const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

type Capture = {
  stream?: MediaStream;
  recorder?: MediaRecorder;
  context?: AudioContext;
  worklet?: AudioWorkletNode;
  timer?: ReturnType<typeof setTimeout>;
  elapsedTimer?: ReturnType<typeof setInterval>;
  startedAt?: number;
};

/**
 * Records a few seconds and plays them back in the browser. The audio never leaves this
 * device: no environment, transcriber, or provider is involved, so a silent result points
 * at the microphone rather than at transcription.
 */
export function MicrophoneTest({
  microphoneId,
  onMicrophoneAccess,
}: {
  microphoneId: string;
  /** Labels and device ids become readable once the browser grants access. */
  onMicrophoneAccess: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "ready">("idle");
  const [recording, setRecording] = useState<{ url: string; duration: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const capture = useRef<Capture | null>(null);
  const recordingUrl = useRef<string | null>(null);

  const releaseCapture = useStableCallback(() => {
    const current = capture.current;
    if (!current) return;
    capture.current = null;
    clearTimeout(current.timer);
    clearInterval(current.elapsedTimer);
    current.worklet?.disconnect();
    current.worklet?.port.close();
    if (current.recorder && current.recorder.state !== "inactive") current.recorder.stop();
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context?.close().catch(() => undefined);
  });
  const discard = () => {
    if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
    recordingUrl.current = null;
    setRecording(null);
    setPhase("idle");
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the microphone and the recording's object URL on unmount
  useEffect(
    () => () => {
      releaseCapture();
      if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
    },
    [releaseCapture],
  );

  const start = async () => {
    releaseCapture();
    discard();
    setError(null);
    setLevel(0);
    setElapsed(0);
    setPhase("starting");
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined" ||
      typeof AudioWorkletNode === "undefined"
    ) {
      setError("此浏览器无法测试麦克风。请使用 HTTPS 或桌面应用。");
      setPhase("idle");
      return;
    }
    const current: Capture = {};
    capture.current = current;
    try {
      const stream = await openMicrophone(microphoneId);
      if (capture.current !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      onMicrophoneAccess();
      const recorder = new MediaRecorder(stream);
      current.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (capture.current === current && data.size) chunks.push(data);
      });
      recorder.addEventListener("stop", () => {
        if (capture.current !== current) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const duration =
          current.startedAt === undefined ? 0 : (performance.now() - current.startedAt) / 1_000;
        releaseCapture();
        setLevel(0);
        if (!blob.size) {
          setError("未录到音频，请重试。");
          setPhase("idle");
          return;
        }
        recordingUrl.current = URL.createObjectURL(blob);
        setRecording({ url: recordingUrl.current, duration });
        setPhase("ready");
      });
      const onRecordingError = () => {
        if (capture.current !== current) return;
        releaseCapture();
        setLevel(0);
        setError("无法录制麦克风音频，请重试。");
        setPhase("idle");
      };
      recorder.addEventListener("error", onRecordingError);
      for (const track of stream.getAudioTracks()) {
        track.addEventListener(
          "ended",
          () => {
            if (capture.current !== current) return;
            setError("麦克风已断开连接。");
            if (recorder.state !== "inactive") recorder.stop();
          },
          { once: true },
        );
      }
      const context = new AudioContext();
      current.context = context;
      await context.audioWorklet.addModule(workletUrl);
      if (capture.current !== current) return;
      const worklet = new AudioWorkletNode(context, "t3-pcm-capture", {
        channelCount: 1,
        processorOptions: { meterOnly: true },
      });
      current.worklet = worklet;
      worklet.port.onmessage = ({ data }: MessageEvent<number | "stopped">) => {
        if (capture.current === current && typeof data === "number") setLevel(data);
      };
      worklet.onprocessorerror = onRecordingError;
      context.createMediaStreamSource(stream).connect(worklet);
      worklet.connect(context.destination);
      await context.resume();
      if (capture.current !== current) return;
      const startedAt = performance.now();
      current.startedAt = startedAt;
      current.elapsedTimer = setInterval(() => {
        setElapsed(Math.min(LOOPBACK_SECONDS, Math.floor((performance.now() - startedAt) / 1_000)));
      }, 100);
      recorder.start();
      worklet.port.postMessage("start", []);
      setPhase("recording");
      current.timer = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, LOOPBACK_SECONDS * 1_000);
    } catch (cause) {
      if (capture.current !== current) return;
      releaseCapture();
      setPhase("idle");
      const name = typeof cause === "object" && cause !== null && "name" in cause && cause.name;
      setError(
        name === "NotAllowedError"
          ? MICROPHONE_PERMISSION_ERROR
          : name === "NotFoundError"
            ? "找不到麦克风。"
            : cause instanceof Error
              ? cause.message
              : "无法访问麦克风。",
      );
    }
  };
  const cancel = () => {
    releaseCapture();
    discard();
    setError(null);
  };

  const control =
    phase === "recording" || phase === "starting" ? (
      <Button
        size="sm"
        variant="outline"
        aria-label="停止录音"
        disabled={phase !== "recording"}
        onClick={() => {
          const recorder = capture.current?.recorder;
          if (recorder && recorder.state !== "inactive") recorder.stop();
        }}
      >
        <SquareIcon />
        停止
      </Button>
    ) : (
      <Button size="sm" variant="outline" onClick={() => void start()}>
        {phase === "ready" ? <RotateCcwIcon /> : <MicIcon />}
        {phase === "ready" ? "重新录音" : "录音"}
      </Button>
    );
  const panel = error ? (
    <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
      {error}
    </p>
  ) : phase === "starting" ? (
    <span role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
      正在打开麦克风…
    </span>
  ) : phase === "recording" ? (
    <>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
      <div className="flex w-24 min-w-0">
        <VoiceWaveform level={level} />
      </div>
      <span
        className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground"
        aria-label="录音时长"
      >
        {formatTime(elapsed)} / {formatTime(LOOPBACK_SECONDS)}
      </span>
      <meter aria-label="输入音量" min={0} max={1} value={level} className="sr-only" />
    </>
  ) : phase === "ready" && recording ? (
    <MicrophonePlayback key={recording.url} src={recording.url} duration={recording.duration} />
  ) : null;

  return (
    <SettingsRow
      {...searchableSetting("microphone-test")}
      title="测试麦克风"
      description="录十秒并播放。音频只留在这台设备上。"
      control={control}
    >
      {panel ? (
        <div
          className={cn(
            "mt-3 mb-2 flex min-h-10 items-center gap-3 rounded-lg border border-border/60 bg-muted/30 py-1 pe-1",
            phase === "ready" && !error ? "ps-1" : "ps-3",
          )}
        >
          {panel}
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={phase === "ready" ? "丢弃录音" : "取消麦克风测试"}
            onClick={cancel}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function MicrophonePlayback({ src, duration }: { src: string; duration: number }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [failed, setFailed] = useState(false);
  const progress = duration > 0 ? Math.min(position / duration, 1) * 100 : 0;

  const togglePlayback = async () => {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) {
      player.pause();
      return;
    }
    setFailed(false);
    if (player.ended) player.currentTime = 0;
    try {
      await player.play();
    } catch {
      setFailed(true);
    }
  };

  return (
    <>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)}
        onError={() => setFailed(true)}
      />
      <Button
        size="icon-sm-pill"
        variant="outline"
        aria-label={playing ? "暂停回放" : "播放录音"}
        onClick={() => void togglePlayback()}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      {failed ? (
        <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
          无法播放此录音，请重新录音。
        </p>
      ) : (
        <input
          type="range"
          aria-label="录音回放位置"
          min={0}
          max={duration}
          step={0.01}
          value={Math.min(position, duration)}
          style={{
            background: `linear-gradient(to right, var(--primary) ${progress}%, var(--muted) ${progress}%)`,
          }}
          disabled={duration <= 0}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (audio.current) audio.current.currentTime = next;
            setPosition(next);
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-slider-thumb]:size-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-moz-range-thumb]:size-2.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary"
        />
      )}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatTime(position)} / {formatTime(duration)}
      </span>
    </>
  );
}
