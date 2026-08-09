import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createGateway } from "./server.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mirasimServer = resolve(projectDir, "vendor", "mirasim-server.cjs");
const [command = "serve", provider] = process.argv.slice(2);

if (command === "login" || command === "relay") {
  if (!existsSync(mirasimServer)) throw new Error(`Missing ${mirasimServer}`);
  const args = [mirasimServer, command, ...(provider ? [provider] : [])];
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} else if (command === "serve") {
  const config = loadConfig();
  const server = createGateway(config);
  server.listen(config.port, config.host, () => {
    server.startModelHealth();
    console.log(`mirasim-2api listening on http://${config.host}:${config.port}`);
    if (config.webAuth.generatedPassword) {
      console.log(`Web console login: ${config.webAuth.username} / ${config.webAuth.password}`);
      console.log("Set WEB_AUTH_PASSWORD before the next start to keep a fixed Web console password.");
    }
  });
} else {
  console.error("Usage: node src/index.js [serve|login [email|github]|relay]");
  process.exitCode = 1;
}
