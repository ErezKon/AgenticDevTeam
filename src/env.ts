/**
 * Environment bootstrap — MUST be imported before any module that reads process.env.
 *
 * Uses override: true so that .env values always win over pre-existing
 * shell environment variables (avoids stale-token bugs).
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });
