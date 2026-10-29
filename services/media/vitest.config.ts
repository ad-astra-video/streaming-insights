import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The E2E test boots the real control server + drives a werift WebRTC peer
    // streaming a real ffmpeg-encoded H264 clip (inter-frame sleeps + window
    // polls), which takes ~12-16s. Default 5s is far too short.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
