import * as ffmpeg from 'fluent-ffmpeg';

/**
 * Configure fluent-ffmpeg to use the ffmpeg/ffprobe binaries shipped by the
 * `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe` packages. This
 * removes the requirement to have ffmpeg installed system-wide (handy on
 * Windows dev machines) while still allowing a system binary to take over if
 * the installer packages are unavailable.
 *
 * Import the exported `ffmpeg` from this module everywhere instead of
 * importing `fluent-ffmpeg` directly, so the binary paths are always set.
 */
let configured = false;

export function configureFfmpeg(): void {
  if (configured) return;
  configured = true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegInstaller?.path) {
      ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    }
  } catch {
    // Fall back to a system ffmpeg on PATH.
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
    if (ffprobeInstaller?.path) {
      ffmpeg.setFfprobePath(ffprobeInstaller.path);
    }
  } catch {
    // Fall back to a system ffprobe on PATH.
  }
}

// Configure on first import.
configureFfmpeg();

export { ffmpeg };
export default ffmpeg;
