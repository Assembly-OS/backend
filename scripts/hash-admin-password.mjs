import { randomBytes, scryptSync } from "node:crypto";

const password = process.env.ADMIN_PASSWORD;
if (!password || password.length < 12) {
  process.stderr.write(
    "Set ADMIN_PASSWORD in the process environment (minimum 12 characters). The plaintext is never printed.\n",
  );
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password.normalize("NFKC"), salt, 64);
process.stdout.write(
  `scrypt$${salt.toString("hex")}$${hash.toString("hex")}\n`,
);
