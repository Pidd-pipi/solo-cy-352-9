import path from "node:path";

function buildMongoUri() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const host = process.env.DB_HOST ?? "localhost";
  const port = Number(process.env.DB_PORT ?? 27017);
  const name = process.env.DB_NAME ?? "app";
  const user = process.env.DB_USER ?? "app";
  const password = process.env.DB_PASSWORD ?? "app_pwd";
  const credentials = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : "";
  return `mongodb://${credentials}${host}:${port}/${name}?authSource=admin`;
}

export const env = {
  port: Number(process.env.PORT ?? 29512),
  mongoUri: buildMongoUri(),
  dataDir: process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
  mongoConnectTimeoutMs: Number(process.env.MONGO_CONNECT_TIMEOUT_MS ?? 3000),
  jwtSecret: process.env.JWT_SECRET ?? "change_me",
};
