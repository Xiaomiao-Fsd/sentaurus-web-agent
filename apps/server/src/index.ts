import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { vmRoutes } from "./routes/vm.js";
import { vmAgentRoutes } from "./routes/vmAgent.js";
import { chatRoutes } from "./routes/chat.js";
import { runRoutes } from "./routes/runs.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: config.CORS_ORIGIN });
await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 } });

await app.register(healthRoutes);
await app.register(vmRoutes);
await app.register(vmAgentRoutes);
await app.register(chatRoutes);
await app.register(runRoutes);

app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
  reply.status(statusCode).send({ ok: false, error: error.message });
});

await app.listen({ host: config.HOST, port: config.PORT });
