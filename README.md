# claude-token-proxy

A lightweight daemon that runs on your local machine and securely serves your Claude.ai OAuth token to GitHub Actions — without ever exposing the raw token.

Built as a companion to [pr-audit](https://github.com/dell-4xz8ls3/pr-audit), which runs Claude-powered PR reviews in CI.

---

## How it works

```
YOUR LOCAL MACHINE                      GITHUB ACTIONS RUNNER
──────────────────────────────          ──────────────────────────────────────
claude-token-proxy serve                pr-audit --auth-token "..."
  reads ~/.claude/.credentials.json       clones + builds claude-token-proxy
  encrypts token with your public key     runs: claude-token-proxy decrypt-token
  serves GET /token over internet           fetches encrypted token via PROXY_URL
                                            decrypts with CLAUDE_PROXY_PRIVATE_KEY
                                            writes raw token to stdout
                                          claude CLI picks up the token
                                          posts review back to the PR
```

The token is encrypted with **RSA-OAEP + AES-256-GCM** hybrid encryption before leaving your machine. The private key never leaves GitHub Secrets.

---

## Requirements

- [Bun](https://bun.sh) (recommended) or Node.js 20+
- [Claude Code](https://claude.ai/code) installed and logged in on your local machine
- Your machine accessible over the internet on the proxy port (port forward or VPN)

---

## Setup (one-time)

### 1. Clone and install

```bash
git clone https://github.com/dell-4xz8ls3/claude-token-proxy.git
cd claude-token-proxy
bun install          # or: pnpm install
```

### 2. Generate your keypair

```bash
bun src/index.ts generate-keys
```

This creates `private.pem` and `public.pem` in the project root. Both are gitignored — keep them safe.

### 3. Add secrets to GitHub

In your repo: **Settings → Secrets and variables → Actions**

| Secret | Value |
|--------|-------|
| `CLAUDE_PROXY_PRIVATE_KEY` | Contents of `private.pem` |
| `CLAUDE_PROXY_URL` | Your machine's public URL e.g. `http://1.2.3.4:7432` |

### 4. Start the daemon

```bash
# Bun — runs directly from source, no build needed
bun src/index.ts serve --public-key ./public.pem --port 7432

# Node — build first, then run
pnpm build
node dist/index.js serve --public-key ./public.pem --port 7432
```

### 5. Verify

```bash
curl http://localhost:7432/health
# {"ok":true,"age_seconds":3,"last_refresh":"...","last_error":null}
```

---

## CLI Reference

```
claude-token-proxy <subcommand> [options]

Subcommands:
  serve                         Start the proxy daemon + HTTP server
    --public-key <path>           RSA public key PEM   (default: public.pem)
    --port <number>               HTTP port            (default: 7432)

  decrypt-token                 Fetch + decrypt the token from a running proxy
    --proxy-url <url>             Proxy URL            (or PROXY_URL env var)
    --private-key <path>          RSA private key PEM  (or CLAUDE_PROXY_PRIVATE_KEY env var)

  generate-keys                 Generate a new RSA-4096 keypair
    --private-key <path>          Output path          (default: private.pem)
    --public-key  <path>          Output path          (default: public.pem)
```

---

## GitHub Actions Integration

Pick one of the two workflow templates from `examples/` and copy it to `.github/workflows/pr-review.yml` in your repo:

| Template | Runtime | Setup time | Build step |
|---|---|---|---|
| `examples/pr-review-bun.yml` | Bun | ~1s | None — runs from source |
| `examples/pr-review-node.yml` | Node 20 | ~30s | `pnpm build` (tsup) |

The `decrypt-token` subcommand is designed to be passed directly as the `--auth-token` helper to `pr-audit`:

```yaml
- name: Run PR Review
  env:
    CLAUDE_PROXY_PRIVATE_KEY: ${{ secrets.CLAUDE_PROXY_PRIVATE_KEY }}
    PROXY_URL: ${{ secrets.CLAUDE_PROXY_URL }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    pr-audit "${{ github.event.pull_request.html_url }}" \
      --auth-token "bun /tmp/claude-token-proxy/src/index.ts decrypt-token"
```

---

## Running as a persistent service

### Quick (background process)

```bash
nohup bun src/index.ts serve --public-key ./public.pem --port 7432 \
  > ~/.claude-proxy/proxy.log 2>&1 &
```

### systemd (Linux)

```ini
# ~/.config/systemd/user/claude-token-proxy.service
[Unit]
Description=Claude Token Proxy
After=network.target

[Service]
WorkingDirectory=/path/to/claude-token-proxy
ExecStart=/usr/local/bin/bun src/index.ts serve --public-key ./public.pem --port 7432
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now claude-token-proxy
```

> An `install-service` subcommand that automates this is planned — see `plans/install-service.md`.

---

## Encryption scheme

```
encryptToken(rawToken, publicKey):
  aesKey  = random 32 bytes
  iv      = random 12 bytes
  ciphertext, tag = AES-256-GCM(rawToken, aesKey, iv)
  encryptedAesKey = RSA-OAEP(aesKey, publicKey)
  return base64( encryptedAesKey[512] + iv[12] + tag[16] + ciphertext )

decryptToken(encryptedToken, privateKey):
  buf            = base64decode(encryptedToken)
  encryptedAesKey = buf[0:512]
  iv             = buf[512:524]
  tag            = buf[524:540]
  ciphertext     = buf[540:]
  aesKey         = RSA-OAEP-decrypt(encryptedAesKey, privateKey)
  return AES-256-GCM-decrypt(ciphertext, aesKey, iv, tag)
```

---

## Project structure

```
src/
  index.ts               CLI entry — subcommand dispatcher
  args.ts                getArg / hasFlag helpers
  crypto.ts              encryptToken / decryptToken / loadPem
  keys.ts                generateKeypair
  token-reader.ts        reads Claude OAuth token from keychain or disk
  daemon.ts              15-min refresh loop + disk cache + in-memory state
  server.ts              HTTP server: GET /token, GET /health
  client.ts              fetchEncryptedToken — HTTP client for decrypt-token
  commands/
    generate-keys.ts     generate-keys subcommand
    decrypt-token.ts     decrypt-token subcommand
    serve.ts             serve subcommand + graceful shutdown
examples/
  pr-review-bun.yml      GitHub Actions template using Bun (copy to your repo)
  pr-review-node.yml     GitHub Actions template using Node.js (copy to your repo)
plans/
  install-service.md     Plan for automated service installation subcommand
```

---

## Security notes

- `private.pem` is gitignored and should never be committed
- The proxy endpoint (`/token`) requires no auth — the token is already encrypted and useless without the private key
- The private key lives only in GitHub Secrets and your local disk (`private.pem`)
- Token age is exposed via `/health` — alert if `age_seconds` exceeds 3600 (stale cache)
