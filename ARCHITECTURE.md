## 1. Autenticação

A autenticação não foi implementada neste timebox. Os controllers de wallet e wagering usam `OptionalAuthGuard`, um guard no-op explícito que deve ser substituído por um guard OIDC antes de produção. O guard real validará JWT e vinculará o `providerId` autenticado ao escopo da requisição. Health checks e consumidor interno SQS permanecem fora desse fluxo; nenhuma tabela local de credenciais é necessária.

## 2. Estratégias de Consistência e Concorrência

### 2.1. Controle de concorrência

O controle de concorrência será realizado pelo PostgreSQL, utilizando **bloqueio pessimista por wallet** (`SELECT ... FOR UPDATE`). Essa estratégia garante que operações financeiras concorrentes sobre a mesma carteira sejam executadas de forma serializada, evitando condições de corrida (_race conditions_) e atualizações perdidas (_lost updates_).

Durante o processamento de uma transação, a aplicação inicia uma transação SQL e obtém o bloqueio da wallet correspondente. Em seguida, valida as regras de negócio, verifica a disponibilidade do saldo e persiste as alterações necessárias. O bloqueio permanece ativo até o commit ou rollback da transação SQL.

Como o bloqueio é gerenciado pelo banco de dados, a garantia permanece válida mesmo quando múltiplas instâncias da aplicação processam operações simultaneamente. Carteiras distintas podem ser processadas em paralelo, evitando a utilização de um bloqueio global.

### 2.2. Consistência financeira e Ledger

O saldo materializado da wallet e seus respectivos lançamentos no ledger devem permanecer consistentes. Toda operação que altera o saldo precisa gerar exatamente um lançamento correspondente, persistido na mesma transação SQL.

O ledger será tratado como um histórico imutável de movimentações financeiras. Lançamentos existentes não poderão ser sobrescritos ou excluídos durante o fluxo normal da aplicação.

A consistência será protegida por transações SQL, constraints no banco de dados e regras de domínio. A tabela de wallets possuirá uma restrição `CHECK` para impedir saldos negativos, enquanto restrições de unicidade impedirão lançamentos duplicados para uma mesma transação e carteira.

A reconciliação será responsável por comparar o saldo materializado com o saldo calculado a partir dos lançamentos do ledger. Divergências serão registradas e sinalizadas, sem correção automática ou silenciosa.

### 2.3. Idempotência persistente

A idempotência será garantida por registros persistidos no PostgreSQL, sem depender de caches ou estruturas em memória.

Toda transação recebida deverá possuir um cabeçalho `Idempotency-Key`. A aplicação calculará um hash do payload canônico, considerando os campos de negócio relevantes e excluindo metadados de transporte.

Quando uma chave já estiver registrada:

- Se o hash corresponder ao payload original, a aplicação retornará o resultado previamente registrado, identificando a requisição como um replay idempotente.
- Se o hash for diferente, a aplicação retornará um conflito de idempotência, sem executar uma nova movimentação financeira.

As constraints de unicidade no banco serão responsáveis por proteger a operação contra requisições simultâneas processadas por diferentes instâncias.

### 2.4. Atomicidade transacional

A alteração do saldo, a atualização do estado da transação financeira, a criação do lançamento no ledger e a persistência dos eventos na Outbox deverão participar da mesma transação SQL.

Quando a operação for recebida por meio do SQS, o registro correspondente na Inbox também será persistido na mesma transação.

Dessa forma, o sistema garante que essas alterações sejam confirmadas conjuntamente ou revertidas em caso de falha, evitando estados parciais entre os registros financeiros e os mecanismos de mensageria.

### 2.5. Inbox e Outbox

A Inbox será utilizada para deduplicar mensagens recebidas do SQS por meio da combinação de `consumerName` e `messageId`. O processamento financeiro e o registro da mensagem como processada serão confirmados atomicamente no PostgreSQL. O ACK da mensagem SQS somente ocorrerá após o commit.

A Outbox será utilizada para registrar eventos de integração na mesma transação que produz seus efeitos financeiros. Um worker independente será responsável por publicar os eventos pendentes no SQS.

Para permitir a execução concorrente de múltiplos publishers, a seleção dos registros pendentes utilizará bloqueios no PostgreSQL, podendo empregar `FOR UPDATE SKIP LOCKED`. Após a publicação, o registro será marcado como publicado. Falhas temporárias resultarão em novas tentativas com backoff.

Como pode ocorrer uma falha após a publicação do evento e antes da atualização de seu estado na Outbox, publicações duplicadas são possíveis. Por esse motivo, os eventos utilizarão identificadores estáveis, permitindo que os consumidores implementem deduplicação e processamento idempotente.

### 2.6. Recuperação de transações fora de ordem

Transações que dependem de uma operação ainda inexistente serão persistidas com o estado `PENDING_REFERENCE`. Um worker agendado tentará resolver novamente a referência utilizando uma estratégia de backoff exponencial.

Quando a referência estiver disponível, a aplicação validará os vínculos de provedor, jogador, carteira, moeda e rodada, além das regras específicas de reversão. Caso o limite de tentativas seja atingido sem que a referência seja encontrada, a transação será rejeitada com um código de falha específico e auditável.

### 2.7. Garantias de consistência

- O saldo de uma wallet nunca poderá se tornar negativo.
- Uma mesma operação financeira não poderá produzir efeitos duplicados.
- O saldo materializado deverá corresponder ao saldo reconstruído a partir do ledger.
- Operações financeiras e seus respectivos lançamentos serão persistidos atomicamente.
- Eventos confirmados na Outbox poderão ser publicados novamente após falhas, sem depender da disponibilidade contínua de uma única instância.
- A correção do sistema não dependerá da ordenação ou deduplicação fornecida pelo SQS.
- Todas as garantias críticas deverão ser verificadas por testes unitários, testes de integração com PostgreSQL e SQS reais em containers e testes de concorrência com múltiplas instâncias.

### 2.8. Fluxos implementados nesta etapa

`Money`, `Wallet`, `WagerTransaction` e `WalletLedgerEntry` encapsulam a criação por factories. `Wallet.open` inicia versão 1; repositórios usam `rehydrate` para reconstruir estado persistido. Valores monetários permanecem como decimal exato e são serializados em strings com duas casas.

O endpoint de wagering aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. A wallet é bloqueada com `SELECT ... FOR UPDATE`; reversões verificam a referência do mesmo provedor e os vínculos de jogador, wallet, moeda e rodada. `REFUND` e `ROLLBACK` exigem valor idêntico ao da referência; `WIN` pode apontar para uma aposta e admite dependência pendente. Reversões processadas são protegidas também pelo índice único parcial `wager_transactions_one_processed_reversal_idx`.

O crédito inicial não zero cria uma transação `OPENING` e uma linha de ledger atomicamente com a wallet. A consulta do ledger usa paginação por `(created_at, id)` em cursor Base64 URL-safe. A reconciliação compara saldo armazenado com a soma do ledger e apenas sinaliza divergências.

O worker `PendingReferenceWorker` reprocessa linhas vencidas por lock de linha no PostgreSQL. O backoff dobra a cada tentativa, limitado a cinco minutos; o padrão é 12 tentativas, configurável com `REFERENCE_MAX_ATTEMPTS`. O estado, ledger, atualização da resposta idempotente e eventos outbox são confirmados na mesma transação.

Eventos são publicados como envelopes versionados por subclasses concretas de `IntegrationEvent`. Em filas FIFO, o grupo é a chave do agregado e o ID da outbox é o ID de deduplicação. A publicação pode repetir após crash entre o envio e a marcação da outbox, então o consumidor deve deduplicar por `eventId`.

O endpoint `GET /metrics` expõe contadores e resumos locais por instância para status de transações, replay idempotente, latência, retries, DLQ, conflitos de lock e atraso da outbox. Esses valores são observabilidade de processo, não estado de negócio: reiniciar a instância reinicia os contadores.

O consumidor SQS renova a visibilidade durante o processamento. Falhas transitórias aumentam a visibilidade por backoff exponencial, de `SQS_RETRY_BASE_DELAY_SECONDS` até `SQS_RETRY_MAX_DELAY_SECONDS`. Erros permanentes de domínio e mensagens que excedem `SQS_MAX_RECEIVE_COUNT` são enviadas diretamente para `SQS_DLQ_QUEUE_URL`, quando configurada; falhas ao enviar para a DLQ deixam a mensagem na fila original. Sem URL explícita de DLQ, a política de redrive da fila de origem controla o descarte.

### 2.9. Códigos de falha e resposta HTTP

Payload inválido retorna `400`; conflitos da chave de idempotência, do ID externo do provedor ou de criação de wallet retornam `409`; wallet ou transação inexistente retorna `404`; rejeições financeiras e de referência são persistidas com status `REJECTED` e retornam `422`; dependências ainda não resolvidas retornam `202`; falhas inesperadas de infraestrutura retornam `5xx` e podem ser reenviadas.

Os códigos estáveis usados nas rejeições são `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_REVERSIBLE`, `REFERENCE_AMOUNT_MISMATCH` e `REFERENCE_ALREADY_REVERSED`. O provedor deve corrigir saldo/identificadores para os dois primeiros grupos financeiros, corrigir referência ou payload nos códigos `REFERENCE_*`, e não reenviar automaticamente uma operação terminal sem alterar sua chave/payload.

A migration `Migration20261018180000_financial_schema_invariants` adiciona checks para valores financeiros e estados suportados, valida a aritmética dos lançamentos, mantém a versão da wallet alinhada a mudanças de saldo e verifica por constraint trigger diferível a consistência entre saldo materializado e ledger no commit. As migrations também protegem contra duplicação de reversões processadas. Os cenários com processos independentes cobrem idempotência concorrente, limite de saldo e recuperação de referência pendente após reinício.
