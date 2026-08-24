import http from "node:http";
import { createConfig } from "../src/config.js";

const config = createConfig();
const printBody = process.argv.includes("--print");

const result = await new Promise((resolve, reject) => {
  const request = http.get(
    {
      hostname: "127.0.0.1",
      port: config.httpPort,
      path: "/health",
      headers: { host: config.webHost },
      timeout: 8000,
    },
    (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    },
  );
  request.on("timeout", () => request.destroy(new Error("healthcheck_timeout")));
  request.on("error", reject);
});

if (printBody) process.stdout.write(`${result.body}\n`);
if (result.statusCode !== 200) process.exitCode = 1;
