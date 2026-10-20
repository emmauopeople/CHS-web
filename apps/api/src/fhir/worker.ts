import pg from 'pg';
import { createFhirTransport, publishNextPatient } from './publication.js';
const base = process.env.FHIR_BASE_URL;
if (!base || !process.env.DATABASE_URL)
  throw new Error('FHIR worker configuration missing');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
});
const transport = createFhirTransport(base);
let stopping = false;
process.once('SIGTERM', () => {
  stopping = true;
});
process.once('SIGINT', () => {
  stopping = true;
});
while (!stopping) {
  try {
    const processed = await publishNextPatient(pool, transport);
    if (!processed) await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch {
    console.error('FHIR worker cycle failed; retrying.');
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}
await pool.end();
