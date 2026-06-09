import type { FastifyRequest } from "fastify";
import { config } from "../config.js";

export function requireAuth(request: FastifyRequest): void {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const queryToken = request.query && typeof request.query === "object"
    ? (request.query as { token?: unknown }).token
    : undefined;
  const provided = token || (typeof queryToken === "string" ? queryToken : undefined);
  if (!provided || provided !== config.AUTH_TOKEN) {
    const error = new Error("Unauthorized") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
}
