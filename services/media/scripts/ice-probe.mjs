// ICE probe: provision a live media session, negotiate an offer/answer with
// werift, and report the answer's ICE candidate types + connectivity.
// Usage: node ice-probe.mjs [mediaBaseUrl] [--trickle]
import { RTCPeerConnection, useVP8 } from "werift";

const base = (process.argv[2] || "https://mage-media.dpn.gg").replace(/\/+$/, "");
const trickle = process.argv.includes("--trickle");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
const provRes = await fetch(`${base}/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ source: "webrtc" }),
});
const prov = await provRes.json();
console.log("provision", provRes.status, "sid=", prov.sessionId);
console.log("iceServers", JSON.stringify((prov.iceServers || []).map((s) => ({ urls: s.urls, user: !!s.username, cred: !!s.credential }))));

const pc = new RTCPeerConnection({
  codecs: { video: [useVP8()] },
  ...(prov.iceServers?.length ? { iceServers: prov.iceServers } : {}),
});
const gathered = [];
pc.onIceCandidate.subscribe((c) => {
  if (!c || !c.candidate) return;
  gathered.push(c);
  if (trickle && prov.sessionId) {
    fetch(`${base}/sessions/${prov.sessionId}/rtc/ice/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } }),
    }).catch(() => {});
  }
});
pc.addTransceiver("video", { direction: "sendonly" });
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
// wait for local gathering to finish (browser-like: up to 5s)
for (let i = 0; i < 50 && pc.iceGatheringState !== "complete"; i++) await sleep(100);
console.log("local gather state", pc.iceGatheringState, "candidates", gathered.length, "types=", [...new Set(gathered.filter((c) => c.candidate).map((c) => (c.candidate.match(/ typ (\w+)/) || [])[1]))].join(","));

const offRes = await fetch(`${base}/sessions/${prov.sessionId}/rtc/offer`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ offer: { type: offer.type, sdp: offer.sdp } }),
});
const offBody = await offRes.json();
console.log("offer", offRes.status, "in", Date.now() - t0, "ms");
if (!offBody.answer) {
  console.log("NO ANSWER", JSON.stringify(offBody));
  process.exit(1);
}
const candLines = offBody.answer.sdp.split("\r\n").filter((l) => l.startsWith("a=candidate:"));
console.log("answer candidates", candLines.length);
for (const l of candLines) {
  const typ = (l.match(/ typ (\w+)/) || [])[1];
  console.log("  typ=", typ, l.replace(/^a=candidate:/, "").slice(0, 110));
}
console.log("answer types=", [...new Set(candLines.map((l) => (l.match(/ typ (\w+)/) || [])[1]))].join(","));
await pc.setRemoteDescription(offBody.answer);

for (let i = 0; i < 200; i++) {
  if (pc.connectionState === "connected" || pc.connectionState === "failed") break;
  await sleep(100);
}
console.log("connectionState", pc.connectionState, "after", Date.now() - t0, "ms");
console.log("selectedPair", JSON.stringify(pc.selectedPair?.toJSON?.() ?? null));
pc.close();
await fetch(`${base}/sessions/${prov.sessionId}/close`, { method: "POST" }).catch(() => {});
process.exit(pc.connectionState === "connected" ? 0 : 2);
