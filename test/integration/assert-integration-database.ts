export function assertIntegrationDatabaseConfigured(): void {
  const database = process.env.POSTGRES_DB?.trim();
  if (!database) {
    throw new Error("Set POSTGRES_DB explicitly before running integration tests.");
  }
  if (
    database === "wagering" &&
    process.env.ALLOW_ORIGINAL_DB_INTEGRATION !== "1"
  ) {
    throw new Error(
      "Integration tests against wagering require ALLOW_ORIGINAL_DB_INTEGRATION=1.",
    );
  }
}
