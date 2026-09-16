#!/usr/bin/env node
const imageId = "sha256:" + "1".repeat(64);
if (process.argv.includes("image"))
  console.log(
    JSON.stringify([{ Id: imageId, Os: "linux", Architecture: "arm64" }]),
  );
else if (process.argv.includes("inspect"))
  console.log(
    JSON.stringify([
      {
        Image: imageId,
        NetworkSettings: {
          Ports: { "5432/tcp": [{ HostPort: "32123", HostIp: "127.0.0.1" }] },
        },
      },
    ]),
  );
else if (process.argv.includes("run")) console.log("fixture-container");
