import { createApp } from './app.js';
import { config } from './config.js';

const { app, makeJobWorker } = createApp();
const worker = makeJobWorker();
worker.start();

const server = app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});

process.on('SIGINT', () => {
  worker.stop();
  server.close();
});

process.on('SIGTERM', () => {
  worker.stop();
  server.close();
});
