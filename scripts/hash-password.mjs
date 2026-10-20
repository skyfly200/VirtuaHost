// Makes a password hash for LOGIN_USERS:  npm run hash-password           (asks for the password, hidden)
//                                         npm run hash-password -- alice   (asks for it and prints "alice:<hash>")
// Produces the same scrypt format as lib/passwords.ts.
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

const user = process.argv[2];
if (user && !/^[A-Za-z0-9_.@-]{1,40}$/.test(user)) {
  console.error("Usernames use letters, numbers and . _ @ - only (up to 40).");
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide what is typed.
    rl._writeToOutput = (text) => { if (text.startsWith(prompt)) process.stdout.write(text); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

const password = await ask("Password (not shown): ");
if (password.length < 10) {
  console.error("Use at least 10 characters (a few random words is fine).");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = `scrypt.${salt.toString("hex")}.${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
console.log(user ? `${user}:${hash}` : hash);
console.error("\nPut that in LOGIN_USERS (several people: separate entries with commas). Also set SESSION_SECRET (openssl rand -hex 32).");
