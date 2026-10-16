import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { ReflectMetadataProvider } from "@mikro-orm/decorators/legacy";

export default defineConfig({
  metadataProvider: ReflectMetadataProvider,

  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  dbName: process.env.POSTGRES_DB ?? "wagering",
  user: process.env.POSTGRES_USER ?? "wagering",
  password: process.env.POSTGRES_PASSWORD ?? "local_dev_password",

  entities: ["./dist/**/*.entity.js"],
  entitiesTs: ["./src/**/*.entity.ts"],

  extensions: [Migrator],

  migrations: {
    path: "./dist/migrations",
    pathTs: "./migrations",
  },
});
