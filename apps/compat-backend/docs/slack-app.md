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
2. **Subscribe to bot events**: `app_mention`, `message.channels`, `message.groups`,
   `message.im` → **Save Changes** (reinstale se o Slack pedir).

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

## Escopo de memória (fase 1)

Canais públicos → space compartilhado da org (`sm_org_shared`). Employee memory (DM),
canais privados (`sm_pch_*`) e account-linking chegam nas fases 2/3.
