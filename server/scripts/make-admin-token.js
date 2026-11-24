/**
 * Prints an admin JWT for the dashboard.
 *   bash:        JWT_SECRET=<same secret as on the server> npm run admin-token
 *   PowerShell:  $env:JWT_SECRET="<same secret as on the server>"; npm run admin-token
 * Optional: npm run admin-token -- 24h   (default lifetime is 8h)
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('Set JWT_SECRET to the same value the server uses (on Render: Environment > JWT_SECRET).');
  process.exit(1);
}
const expiresIn = process.argv[2] || '8h';
console.log(jwt.sign({ sub: 'dashboard-admin', role: 'admin' }, secret, { expiresIn }));
