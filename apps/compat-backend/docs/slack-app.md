# Company Brain — Slack app setup (self-hosted)

O bot vive no compat backend (`src/slack.ts`, montado em `/brain/slack`). Em produção:
`https://api.os.avenia.tech`.

- OAuth redirect: `https://api.os.avenia.tech/brain/slack/oauth/callback`
- Events request URL: `https://api.os.avenia.tech/brain/slack/events`
- Volta pro console após instalar: `https://os.avenia.tech/?slack=connected`

## 1) Criar o app a partir do manifest

`api.slack.com/apps` → **Create New App** → **From a manifest** → escolha o workspace → cole:

```yaml
display_information:
  name: Supermemory
  description: Company Brain — a memória do time no Slack
features:
  bot_user:
    display_name: supermemory
    always_online: true
oauth_config:
  redirect_urls:
    - https://api.os.avenia.tech/brain/slack/oauth/callback
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - channels:join        # only if SLACK_AUTO_JOIN is used
      - chat:write
      - users:read
      - users:read.email
      - team:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

> Sem `event_subscriptions` de propósito: o Slack só verifica a Events URL quando o endpoint
> já está no ar com o Signing Secret. Ligamos os eventos no passo 4, depois do deploy.

## 2) Signing Secret na VM (sempre necessário)

Em **Basic Information → App Credentials**, copie o **Signing Secret**. No `.env` do compat na
VM (`/opt/supermemory-app/apps/compat-backend/.env`), acrescente (segredos NUNCA vão pro
git/Notion):

```bash
SLACK_SIGNING_SECRET=...
SLACK_EXTRACTION_MODE=durable   # durable (padrão) | all | on-demand
```

## 3) Conectar o bot token — escolha A ou B

O App-Level token (`xapp-…`) **não é usado** (é só pra Socket Mode). O bot token (`xoxb-…`)
vem por um destes caminhos:

**A) OAuth "Add to Slack" (multi-workspace):** copie Client ID/Secret e adicione ao `.env`:
```bash
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
```
Depois de ligar os eventos (passo 4), instale pelo console: **Company Brain → Add to Slack**
(o `xoxb` é buscado e guardado automaticamente).

**B) Colar o token (1 workspace, mais simples):** no app Slack → **OAuth & Permissions** →
**Install to Workspace** → copie o **Bot User OAuth Token** (`xoxb-…`) e adicione ao `.env`:
```bash
SLACK_BOT_TOKEN=xoxb-...
# SLACK_ORG_ID=   # opcional; senão usa a org mais antiga do banco
```
Sem Client ID/Secret nem botão OAuth — o install é registrado sozinho a partir do token.

Reinicie após editar o `.env`: `sudo systemctl restart supermemory-compat`.

## 4) Ligar os eventos

1. No app Slack → **Event Subscriptions** → Enable → **Request URL**:
   `https://api.os.avenia.tech/brain/slack/events` → deve dar **Verified** ✅.
2. **Subscribe to bot events**: `app_mention`, `message.channels`, `user_change`, `team_join`
   (obrigatórios) e
   `channel_created` (só com `SLACK_AUTO_JOIN`) → **Save Changes** → reinstale se o Slack pedir.
   `message.groups`/`message.im` não são necessários na fase 1: o backend descarta canais
   privados e DMs.

`GET /brain/slack/status` deve retornar `{connected:true}` (opção B: já após o restart;
opção A: após o "Add to Slack").

## 5) Testar

- Adicione o bot num canal público (`/invite @supermemory`).
- Poste algo durável (ex.: "A política de reembolso é até R$500 sem aprovação").
  No modo `durable`, o LLM decide se guarda e extrai os fatos → vira memória no space da org.
- `@supermemory qual a política de reembolso?` → responde citando a fonte (canal + permalink).
- Salvar manualmente: `@supermemory lembra: o deploy de prod é sexta 14h`.

## Modos de extração (`SLACK_EXTRACTION_MODE`)

| modo | comportamento |
|---|---|
| `durable` (padrão) | LLM triagem: guarda só o que é conhecimento durável, já extraído em fatos. |
| `all` | guarda toda mensagem não-trivial verbatim (mais ruído, mais custo de LLM/embeddings). |
| `on-demand` | captura passiva desligada; só guarda no gatilho `@bot lembra: ...`. |

## Quais canais entram

O bot só recebe mensagens dos canais em que é membro. Duas formas:

- **Convite manual** (padrão): `/invite @supermemory` em cada canal público.
- **Auto-join** (`SLACK_AUTO_JOIN=true`, escopo `channels:join`): a cada 6h (e no boot) o bot
  entra em todo canal público interno; com o evento `channel_created`, entra nos novos na
  hora. `SLACK_AUTO_JOIN_EXCLUDE` lista IDs de canal a ignorar e
  `SLACK_AUTO_JOIN_EXCLUDE_PATTERNS` (padrão `alerts-*,*-alerts,*-alerts-*,*-alertas,*-deploys`) ignora pelo
  nome, inclusive canais criados depois. Convite manual continua valendo para um canal excluído. Sem o escopo, o backend loga
  `auto-join disabled` e segue só com os convites.

Antes de ingerir, o backend confere o canal em `conversations.info`: só canais públicos
internos vão para o space da org. Canais privados, DMs e canais Slack Connect
(`SLACK_INCLUDE_SHARED_CHANNELS` desligado) são descartados, inclusive no `@bot lembra:`.

## Fila de ingestão e diagnóstico

Cada mensagem vira uma linha em `sm_slack_ingest` (no `compat.sqlite`), processada por um
worker a cada 15s: canal → triagem (modo `durable`) → `POST /v3/documents` no lite →
acompanha o status até `done`. Falha no LLM, no lite ou um documento `failed` no lite volta para a
fila com backoff (30s → 1h, até `SLACK_INGEST_MAX_ATTEMPTS`). O texto é apagado da fila quando
a linha termina (`done`, `not_durable`, `skipped`); linhas `dead` mantêm o texto para reprocesso
(`UPDATE sm_slack_ingest SET status='pending', attempts=0, next_at=0 WHERE status='dead'`).

Logs (`journalctl -u supermemory-compat | grep '\[slack\]'`) só têm IDs, status e classe do
erro, nunca o texto: `ingest queued|posted|done|not_durable|skipped|retry|dead`,
`channel sync … member=N`. `GET /brain/slack/status` devolve as contagens da fila e o número de
canais públicos em que o bot está.

## Identidade das pessoas

O compat mantém um diretório do Slack em `sm_slack_user` (`users.list` no boot e a cada 6h, mais
os eventos `user_change`/`team_join`): nome, display name, e-mail, cargo, fuso, bot, guest,
desativado. Os escopos `users:read` + `users:read.email` bastam (o cargo vem do perfil em
`users.list`). A identidade canônica é o **e-mail**.

Cada documento ingerido:
- começa com a atribuição, ex. `Nome (cargo) em #canal: …`, e a triagem `durable` recebe esse
  cabeçalho e é instruída a manter quem disse/decidiu o quê;
- tem as menções reescritas: `<@U…>` → `@Nome` (bots como `@Nome (bot)`), `<#C…|x>` → `#x`,
  links `<url|texto>` → `texto (url)`;
- leva nos metadados `authorSlackId`, `authorName`, `authorEmail`, `authorTitle`,
  `authorUserId` (usuário do console com o mesmo e-mail), `authorIsBot`, `authorIsGuest`,
  `authorDeactivated`, `mentionedUserIds` e `mentionedEmails` (listas separadas por vírgula; bots
  ficam fora dos e-mails).

Mensagens postadas por bots, apps e workflows não são ingeridas.

## Escopo de memória (fase 1)

Canais públicos → space compartilhado da org (`sm_org_shared`). Employee memory (DM),
canais privados (`sm_pch_*`) e account-linking chegam nas fases 2/3.
