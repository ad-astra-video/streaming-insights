import { loadMediaConfig } from "./config";
import { MediaServer } from "./server";

async function main() {
  const cfg = loadMediaConfig();
  const ms = new MediaServer({ cfg });
  const app = await ms.build();
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(
    `streaming-insights media server on :${cfg.port} ` +
      `(control=${cfg.controlBase ? "on" : "local"}, runner=${cfg.runnerBase ? cfg.runnerBase : "mock"}, windowFrames=${cfg.windowFrames})`
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
