import { createApp } from './app.js';
import { config } from './config.js';

const { app } = await createApp();
await app.listen(config.port);
console.log(`MEDORA API on http://localhost:${config.port}/api  (WebSocket /ws)`);
