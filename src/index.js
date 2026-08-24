import http from "node:http";
import { createConfig } from "./config.js";
import { MailboxDatabase } from "./database.js";
import { SmtpService } from "./smtp.js";
import { createHttpApp } from "./app.js";

const config = createConfig();
if (config.nodeEnv === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}

const database = new MailboxDatabase(config);
const smtpService = new SmtpService(config, database);
const app = createHttpApp({ config, database, smtpService });
const httpServer = http.createServer(app);

await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(config.httpPort, config.httpHost, resolve);
});

try {
  await smtpService.start();
} catch (error) {
  console.error(`SMTP startup failed: ${error.message}`);
  httpServer.close();
  database.close();
  throw error;
}

console.log(JSON.stringify({
  event: "service_started",
  http: `${config.httpHost}:${httpServer.address().port}`,
  smtp: `${config.smtpHost}:${smtpService.port}`,
  domain: config.mailDomain,
  domains: config.mailDomains,
  controlHost: config.domains.controlHost,
  mxHost: config.mxHost,
  tls: smtpService.health().tls,
}));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "shutdown", signal }));
  await smtpService.stop().catch(() => {});
  await new Promise((resolve) => httpServer.close(resolve));
  database.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal).finally(() => process.exit(0)));
}
