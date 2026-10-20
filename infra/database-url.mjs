import { readFileSync } from 'node:fs';

const password = readFileSync('/run/secrets/postgres_password', 'utf8').trim();
if (!password) throw new Error('Database password is empty');
const url = new URL('postgresql://postgres:5432/chs');
url.username = 'chs';
url.password = password;
process.stdout.write(url.href);
