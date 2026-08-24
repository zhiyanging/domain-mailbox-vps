import { createConfig } from "./config.js";
import { MailboxDatabase } from "./database.js";

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("stdin_json_required");
  return JSON.parse(text);
}

async function main() {
  const command = String(process.argv[2] || "status");
  const config = createConfig();
  const database = new MailboxDatabase(config);
  try {
    if (command === "status") {
      console.log(JSON.stringify({ adminReady: database.adminExists(), ...database.statistics() }, null, 2));
      return;
    }
    if (command === "bootstrap" || command === "reset-admin") {
      const input = await readStdinJson();
      const admin = await database.bootstrapAdmin({
        username: input.username || "admin",
        password: input.password,
        apiToken: input.apiToken,
        replace: command === "reset-admin",
      });
      console.log(JSON.stringify({ ok: true, username: admin.username, rotated: command === "reset-admin" }));
      return;
    }
    if (command === "backup") {
      const input = await readStdinJson();
      const destination = String(input.destination || "").trim();
      if (!destination) throw new Error("backup_destination_required");
      await database.db.backup(destination);
      console.log(JSON.stringify({ ok: true, destination }));
      return;
    }
    throw new Error(`unknown_command:${command}`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
