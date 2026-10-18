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

Os exemplos abaixo assumem a API em `http://localhost:3000` e uma wallet em BRL. Valores monetários são strings decimais com duas casas; não os envie como números JSON.
Autenticação é opcional neste desafio e não está habilitada nesta implementação; não é necessário enviar bearer token.

### Health checks

```sh
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
```

Ambos retornam `200` quando saudáveis. Readiness informa separadamente o estado de PostgreSQL e SQS; se alguma dependência estiver indisponível, retorna `503`. Health checks ficam abertos.

### Criar e consultar uma wallet

```sh
curl -i -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "player-123",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

Sucesso retorna `201` e uma resposta como:

```json
{
  "id": "<wallet-id>",
  "playerId": "player-123",
  "currency": "BRL",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

Quando `initialBalance` for maior que zero, a abertura também grava uma transação interna `OPENING`, um crédito no ledger e os eventos da outbox na mesma transação. Se omitido, o saldo inicial é zero. Criar outra wallet para o mesmo `playerId` e moeda retorna `409`.

Use o ID retornado para consultar a wallet:

```sh
WALLET_ID='<wallet-id-retornado>'
curl -i "http://localhost:3000/wallets/${WALLET_ID}"
```

A resposta contém `id`, `playerId`, `currency`, `balance` e `version`. Uma wallet inexistente retorna `404`.

### Consultar o ledger e reconciliar o saldo

```sh
WALLET_ID='<wallet-id-retornado>'
curl -i "http://localhost:3000/wallets/${WALLET_ID}/ledger?limit=50"
```

A resposta contém `items` em ordem decrescente de data e ID, além de `nextCursor`. Quando houver outra página, passe o cursor opaco recebido na próxima chamada:

```sh
NEXT_CURSOR='<nextCursor-retornado>'
curl -i --get "http://localhost:3000/wallets/${WALLET_ID}/ledger" \
  --data-urlencode 'limit=50' \
  --data-urlencode "cursor=${NEXT_CURSOR}"
```

O limite padrão é 50 e o máximo é 100. Cada item inclui a transação, direção (`CREDIT` ou `DEBIT`), valor, moeda e saldos antes/depois. Cursor inválido retorna `400`.

```sh
curl -i -X POST "http://localhost:3000/wallets/${WALLET_ID}/reconciliation"
```

A reconciliação retorna `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`. A chamada retorna `201`; divergências são sinalizadas e contabilizadas, sem correção automática.

### Submeter uma transação de wagering

```sh
curl -i -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "player-123",
    "walletId": "<wallet-id-retornado>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

O header `Idempotency-Key` é obrigatório. Tipos aceitos: `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`; `OPENING` é interno. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. `REFUND` deve referenciar uma aposta processada; `ROLLBACK` pode referenciar uma aposta, vitória ou reembolso processado. A referência deve pertencer ao mesmo provedor, jogador, wallet, moeda e rodada.

`BET` debita; `WIN` credita; `LOSS` registra o resultado sem alterar o saldo; `REFUND` credita a aposta revertida; `ROLLBACK` aplica o efeito inverso da transação referenciada.

Exemplo de reembolso: use uma nova chave e um novo ID externo, referenciando a aposta original. O valor deve ser igual ao da aposta:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "refund-123",
  "playerId": "player-123",
  "walletId": "<wallet-id-retornado>",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "REFUND",
  "referenceExternalTransactionId": "transaction-123",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Para `ROLLBACK`, troque `kind` para `ROLLBACK` e use como referência a operação processada que será desfeita, mantendo o valor igual ao da referência.

Uma aposta processada retorna `200`:

```json
{
  "transactionId": "<transaction-id>",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "failureCode": null,
  "idempotentReplay": false
}
```

Reenvie exatamente o mesmo corpo com a mesma chave para obter o resultado original; a resposta terá `idempotentReplay: true`. Reutilizar a chave com outro payload retorna `409`. Reutilizar o ID externo do provedor com outra chave também retorna `409`.

Uma dependência ainda não encontrada retorna `202`, com `status: "PENDING_REFERENCE"`; o worker tentará resolvê-la. Uma rejeição de regra de negócio, como saldo insuficiente, retorna `422`, `status: "REJECTED"` e um `failureCode` estável. JSON/campos inválidos retornam `400`; falhas inesperadas de infraestrutura retornam `5xx`.

Erros HTTP seguem o formato `{ "statusCode", "code", "message" }`. Por exemplo, uma chave de idempotência reutilizada com outro payload retorna `409`:

```json
{
  "statusCode": 409,
  "code": "IDEMPOTENCY_KEY_REUSED",
  "message": "The idempotency key was already used with a different payload."
}
```

Para consultar uma transação, use seu ID interno ou o par de identificadores do provedor:

```sh
TRANSACTION_ID='<transaction-id-retornado>'
curl -i "http://localhost:3000/wagering/transactions/${TRANSACTION_ID}"
curl -i http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

Essas consultas retornam `transactionId`, identificadores do provedor e do jogador, wallet, rodada, jogo, tipo, valor, status, `failureCode`, `createdAt` e `processedAt`. Uma transação inexistente retorna `404`.

### Métricas

```sh
curl -i http://localhost:3000/metrics
```

Retorna os contadores e resumos de observabilidade mantidos pela instância atual. Eles são reiniciados quando o processo reinicia.

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para decisões, garantias e limitações conhecidas.
