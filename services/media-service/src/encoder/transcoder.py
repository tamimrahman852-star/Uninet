"""Adaptive-bitrate HLS transcoding with ffmpeg, plus OpenCV thumbnail extraction.

A single ffmpeg process decodes the source once, splits it into every rendition that does not upscale the
source (up to 4K) and writes an HLS master playlist with one media playlist per rendition:

    out/master.m3u8
    out/2160p/index.m3u8 + seg_00000.ts ...
    out/1080p/...
"""

import asyncio
import json
import logging
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

log = logging.getLogger("media.transcoder")

ProgressCallback = Callable[[float], Awaitable[None]]


class TranscodeError(Exception):
    """Raised when probing or transcoding fails; the message is safe to show to the uploader."""


@dataclass(frozen=True, slots=True)
class Rendition:
    name: str
    height: int
    video_kbps: int
    maxrate_kbps: int
    bufsize_kbps: int
    audio_kbps: int


LADDER: tuple[Rendition, ...] = (
    Rendition("2160p", 2160, 14000, 15400, 21000, 192),
    Rendition("1080p", 1080, 5000, 5350, 7500, 128),
    Rendition("720p", 720, 2800, 2996, 4200, 128),
    Rendition("480p", 480, 1400, 1498, 2100, 96),
    Rendition("360p", 360, 800, 856, 1200, 64),
)


@dataclass(slots=True)
class MediaInfo:
    width: int
    height: int
    duration: float
    has_audio: bool
    video_codec: str


async def _run_capture(*cmd: str, timeout: float) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.DEVNULL
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise TranscodeError(f"{cmd[0]} timed out") from None
    return proc.returncode or 0, out, err


async def probe(path: Path, timeout: float = 90.0) -> MediaInfo:
    """Inspect a media file with ffprobe."""
    code, out, err = await _run_capture(
        "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path), timeout=timeout
    )
    if code != 0:
        log.warning("ffprobe failed: %s", err.decode("utf-8", errors="replace")[-300:])
        raise TranscodeError("The file is not a valid video")
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        raise TranscodeError("The file is not a valid video") from None

    streams = data.get("streams", [])
    video = next(
        (s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")),
        None,
    )
    if video is None:
        raise TranscodeError("The file does not contain a video stream")

    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    if width <= 0 or height <= 0:
        raise TranscodeError("The video has invalid dimensions")

    rotation = 0
    for side_data in video.get("side_data_list", []) or []:
        if "rotation" in side_data:
            rotation = int(float(side_data["rotation"]))
    rotation = rotation or int(float((video.get("tags") or {}).get("rotate", 0) or 0))
    if abs(rotation) % 180 == 90:  # ffmpeg auto-rotates, so the displayed size is swapped
        width, height = height, width

    duration = float((data.get("format") or {}).get("duration") or video.get("duration") or 0)
    if duration <= 0:
        raise TranscodeError("Could not determine the video duration")

    return MediaInfo(
        width=width,
        height=height,
        duration=duration,
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        video_codec=str(video.get("codec_name", "unknown")),
    )


def select_renditions(source_height: int) -> list[Rendition]:
    """Renditions that do not upscale the source (tiny tolerance for 1088-style heights)."""
    chosen = [r for r in LADDER if r.height <= source_height + 8]
    if chosen:
        return chosen
    even_height = max(2, source_height - source_height % 2)
    return [Rendition(f"{even_height}p", even_height, 600, 642, 900, 64)]


def build_ffmpeg_command(
    source: Path, out_dir: Path, info: MediaInfo, renditions: list[Rendition], preset: str
) -> list[str]:
    n = len(renditions)
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-i", str(source)]

    if n > 1:
        labels = "".join(f"[s{i}]" for i in range(n))
        filters = [f"[0:v:0]split={n}{labels}"]
    else:
        filters = ["[0:v:0]null[s0]"]
    for i, r in enumerate(renditions):
        filters.append(f"[s{i}]scale=-2:{r.height}:flags=lanczos,format=yuv420p[v{i}]")
    cmd += ["-filter_complex", ";".join(filters)]

    for i, r in enumerate(renditions):
        cmd += [
            "-map", f"[v{i}]",
            f"-c:v:{i}", "libx264",
            f"-b:v:{i}", f"{r.video_kbps}k",
            f"-maxrate:v:{i}", f"{r.maxrate_kbps}k",
            f"-bufsize:v:{i}", f"{r.bufsize_kbps}k",
        ]
        if info.has_audio:
            cmd += ["-map", "a:0", f"-c:a:{i}", "aac", f"-b:a:{i}", f"{r.audio_kbps}k", "-ac", "2"]

    var_map = " ".join(
        f"v:{i},a:{i},name:{r.name}" if info.has_audio else f"v:{i},name:{r.name}" for i, r in enumerate(renditions)
    )
    cmd += [
        "-preset", preset,
        "-profile:v", "high",
        "-sc_threshold", "0",
        "-force_key_frames", "expr:gte(t,n_forced*6)",
        "-f", "hls",
        "-hls_time", "6",
        "-hls_playlist_type", "vod",
        "-hls_flags", "independent_segments",
        "-hls_segment_type", "mpegts",
        "-hls_segment_filename", str(out_dir / "%v" / "seg_%05d.ts"),
        "-master_pl_name", "master.m3u8",
        "-var_stream_map", var_map,
        str(out_dir / "%v" / "index.m3u8"),
    ]
    return cmd


async def transcode_hls(
    source: Path,
    out_dir: Path,
    info: MediaInfo,
    renditions: list[Rendition],
    preset: str = "veryfast",
    timeout: float = 6 * 3600,
    progress: ProgressCallback | None = None,
) -> Path:
    """Run ffmpeg and return the path of master.m3u8."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for r in renditions:
        (out_dir / r.name).mkdir(parents=True, exist_ok=True)

    cmd = build_ffmpeg_command(source, out_dir, info, renditions, preset)
    log.info("transcoding %s into %s", source.name, [r.name for r in renditions])
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.DEVNULL
    )
    stderr_tail: deque[str] = deque(maxlen=40)

    async def drain_stderr() -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            stderr_tail.append(raw.decode("utf-8", errors="replace").rstrip())

    async def read_progress() -> None:
        assert proc.stdout is not None
        last_reported = -1.0
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            key, _, value = line.partition("=")
            if key in ("out_time_us", "out_time_ms") and value.lstrip("-").isdigit() and progress is not None:
                seconds = int(value) / 1_000_000
                fraction = max(0.0, min(1.0, seconds / info.duration))
                if fraction - last_reported >= 0.02:
                    last_reported = fraction
                    await progress(fraction)

    stderr_task = asyncio.create_task(drain_stderr())
    progress_task = asyncio.create_task(read_progress())
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise TranscodeError("Transcoding took too long") from None
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise
    finally:
        await asyncio.gather(stderr_task, progress_task, return_exceptions=True)

    if proc.returncode != 0:
        log.error("ffmpeg failed (%s): %s", proc.returncode, "\n".join(stderr_tail))
        raise TranscodeError("The video could not be processed")

    master = out_dir / "master.m3u8"
    if not master.exists():
        raise TranscodeError("Transcoding produced no output")
    return master


def _extract_thumbnail_sync(source: Path, target: Path, at_seconds: float, width: int) -> None:
    import cv2  # imported lazily: heavy and only needed here

    capture = cv2.VideoCapture(str(source))
    try:
        if not capture.isOpened():
            raise TranscodeError("Could not open the video for thumbnail extraction")
        capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, at_seconds) * 1000)
        ok, frame = capture.read()
        if not ok:
            capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = capture.read()
        if not ok or frame is None:
            raise TranscodeError("Could not read a frame for the thumbnail")
        height, original_width = frame.shape[:2]
        if original_width > width:
            scale = width / original_width
            frame = cv2.resize(frame, (width, max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
        if not cv2.imwrite(str(target), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85]):
            raise TranscodeError("Could not write the thumbnail")
    finally:
        capture.release()


async def extract_thumbnail(source: Path, target: Path, duration: float, width: int = 640) -> Path:
    """Grab a frame near 10% of the video (max 10 s in) with OpenCV and save it as a JPEG."""
    at = min(duration * 0.1, 10.0)
    await asyncio.to_thread(_extract_thumbnail_sync, source, target, at, width)
    return target
