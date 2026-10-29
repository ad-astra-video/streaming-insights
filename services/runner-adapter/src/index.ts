import { loadAdapterConfig } from "./config.js";
import { buildAdapterApp } from "./server.js";

async function main() {
  const cfg = loadAdapterConfig();
  const app = buildAdapterApp(cfg);
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(
    `streaming-insights Mage-VL window adapter on :${cfg.port} (upstream=${cfg.upstream}, model=${cfg.model}, gate=${cfg.gateThreshold})`,
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
