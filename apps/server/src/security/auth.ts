import type { FastifyRequest } from "fastify";
import { config } from "../config.js";

export function requireAuth(request: FastifyRequest): void {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token || token !== config.AUTH_TOKEN) {
    const error = new Error("Unauthorized") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
}
