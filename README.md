# Jungle Gaming — Distributed Wagering Processor

Backend NestJS/TypeScript com PostgreSQL, MikroORM, ledger financeiro, idempotência persistente, inbox/outbox e integração SQS.

## Desenvolvimento local

Requisitos: Bun 1.x e Docker Compose.

1. Instale dependências com `bun install`.
2. Crie a configuração local: `cp .env.example .env`. Os valores do exemplo são destinados apenas ao ambiente local; ajuste as portas caso já estejam ocupadas.
3. Inicie PostgreSQL e LocalStack com `docker compose up -d`. O hook de inicialização do LocalStack cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`; a fila de entrada é configurada para redrive à DLQ.
4. Aplique migrations com `bunx mikro-orm migration:up`.
5. Inicie o serviço com `bun run start:dev`.

O `.env.example` configura as variáveis usadas pelo Compose e pela aplicação, incluindo `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `AWS_REGION`, `SQS_ENDPOINT`, `SQS_QUEUE_URL`, `SQS_DLQ_QUEUE_URL` e `SQS_OUTBOX_QUEUE_URL`. Para LocalStack, as URLs das filas já apontam para `localhost:4566`. Também é possível ajustar `SQS_MAX_RECEIVE_COUNT` (padrão `5`), `SQS_VISIBILITY_TIMEOUT` (padrão `60`), `SQS_RETRY_BASE_DELAY_SECONDS` (padrão `1`), `SQS_RETRY_MAX_DELAY_SECONDS` (padrão `300`) e `SQS_CONSUMER_NAME`.

## Comandos

- `bun run typecheck`: verifica TypeScript estrito.
- `bun run build`: gera a aplicação em `dist/`.
- `bun run test`: executa os testes unitários, sem acessar o banco.
- `bun run test:integration`: executa as integrações; defina explicitamente `POSTGRES_DB` para um banco isolado já migrado.
- `bun run test:integration:commit-ack`: valida redelivery após falha de ACK e encerramento abrupto do worker depois do commit no banco local `wagering`; remove os registros criados pelos cenários.
- `bun run test:integration:retry-dlq`: valida retry, redelivery e DLQ com filas temporárias reais no LocalStack, sem acessar o PostgreSQL.
- `bun run test:integration:outbox-recovery`: simula a queda do publisher depois do commit e valida a publicação por uma nova instância, usando uma linha isolada no banco `wagering` e uma fila temporária no LocalStack.
- `bun run test:integration:sqs-shutdown`: envia `SIGTERM` a um processo filho com uma mensagem em andamento e valida a conclusão do processamento e do ACK no LocalStack, sem acessar o PostgreSQL.

O worker de referências usa `REFERENCE_MAX_ATTEMPTS` (padrão `12`), `REFERENCE_POLL_INTERVAL_MS` (padrão `1000`) e `REFERENCE_BATCH_SIZE` (padrão `25`).

O consumidor SQS renova a visibilidade enquanto processa uma mensagem. Erros de domínio e mensagens que atingem `SQS_MAX_RECEIVE_COUNT` são enviados à DLQ quando `SQS_DLQ_QUEUE_URL` estiver configurada; sem URL de DLQ, a política de redrive configurada na fila de origem controla as tentativas.

## Endpoints

- `GET /health/live` e `GET /health/ready`.
- `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`.
- `POST /wallets/:walletId/reconciliation`.
- `POST /wagering/transactions` com `Idempotency-Key` obrigatório.
- `GET /wagering/transactions/:transactionId`.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
- `GET /metrics` com contadores locais da instância.

O saldo em todos os contratos usa decimal como string e inclui moeda, por exemplo `{ "amount": "25.00", "currency": "BRL" }`.

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para decisões, garantias e limitações conhecidas.
