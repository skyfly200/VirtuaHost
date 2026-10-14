#!/usr/bin/env node
// Prints a hash for ADMIN_PASSWORD_HASH:  npm run hash-password -- 'the password'
// Without an argument it reads the password from stdin so it stays out of shell history.
const { hashPassword } = require('./auth');

function done(password) {
  if (!password || password.length < 10) {
    console.error('Use a password of at least 10 characters.');
    process.exit(1);
  }
  console.log(hashPassword(password));
}

if (process.argv[2]) {
  done(process.argv[2]);
} else {
  let data = '';
  process.stdin.on('data', (d) => { data += d; });
  process.stdin.on('end', () => done(data.replace(/\r?\n$/, '')));
}
