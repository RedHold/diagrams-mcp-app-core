# Deploy: the remote MCP server at mcp.diagrams.so (AWS Elastic Beanstalk)

The Claude connector's **resource half** — a small **Node/express container** running as its
**own Elastic Beanstalk environment** (Docker platform), the same EB pattern the app / API /
docs envs already use. It is **stateless and holds no secrets**: every request is authenticated
by the OAuth Bearer it forwards to the Diagrams API (`src/http.ts`). Pairs with the OAuth
authorization server in `diagramz-app-core` (behind `OAUTH_AS_ENABLED`).

This adds **no new AWS service** beyond another EB env, **no third party**, and is **100% your own
AWS infra**. The container build + a full protocol smoke run in CI (`.github/workflows/ci.yml`);
this file is the cluster-specific apply.

## Fill in these values
- `REGISTRY` — your ECR repo, e.g. `1234567890.dkr.ecr.us-east-1.amazonaws.com/diagrams-mcp`
- the **MCP EB application + environment** names (create a new EB app/env, Docker platform)
- `mcp.diagrams.so` — Route 53 record → the EB env; **ACM cert** on the ALB (HTTPS)

## 1. Build + push the image
```bash
IMG="REGISTRY:$(git rev-parse --short HEAD)"
docker build -f deploy/Dockerfile -t "$IMG" .
aws ecr get-login-password | docker login --username AWS --password-stdin "${REGISTRY%%/*}"
docker push "$IMG"
```

## 2. Deploy the MCP EB environment (Docker platform)
Create a new EB application + environment (Docker running on 64bit Amazon Linux 2023), then deploy a
bundle whose only file is `Dockerrun.aws.json` pointing at the image (mirrors the docs env):
```bash
sed "s#REGISTRY/diagrams-mcp:latest#$IMG#" deploy/Dockerrun.aws.json > Dockerrun.aws.json
zip mcp.zip Dockerrun.aws.json
aws s3 cp mcp.zip s3://<your-eb-bucket>/mcp-$(git rev-parse --short HEAD).zip
aws elasticbeanstalk create-application-version --application-name <mcp-eb-app> \
  --version-label "mcp-$(git rev-parse --short HEAD)" \
  --source-bundle S3Bucket=<your-eb-bucket>,S3Key=mcp-$(git rev-parse --short HEAD).zip
aws elasticbeanstalk update-environment --environment-name <mcp-eb-env> \
  --version-label "mcp-$(git rev-parse --short HEAD)"
```

## 3. Environment properties (EB → Configuration → Software)
| Var | Value | Why |
|---|---|---|
| `MCP_PUBLIC_URL` | `https://mcp.diagrams.so` | the resource URL; must equal what the user enters. Drives the PRM `resource` + `WWW-Authenticate`. |
| `OAUTH_ISSUER` | `https://api.diagrams.so` | the authorization server named in the protected-resource metadata. |
| `DIAGRAMS_API_BASE` | `https://api.diagrams.so/api/v2` | where tool calls are forwarded. |
| `DIAGRAMS_NO_AUTO_LOGIN` | `1` | already baked into the image; harmless to set again. |

`PORT` is optional — the container listens on `8080` (matches `Dockerrun.aws.json` `ContainerPort`).

## 4. DNS + TLS + health + timeouts
- Point **`mcp.diagrams.so`** at the EB env (Route 53) and attach an **ACM cert** to the ALB (HTTPS).
- ALB **health check path = `/health`** (returns `ok`).
- Set the ALB **idle timeout ≥ 400s** — above the API's 360s ceiling — so the outer connection never
  dies before an inner one (generation p50 ~30s, but the Claude → MCP → API hop must not truncate a
  slow call). The client's own budget is 450s.
- If the env is network-restricted, allow Anthropic egress **`160.79.104.0/21`**.

## 5. Verify live (prod smoke — matches issue #833 step 5)
```bash
curl -s https://mcp.diagrams.so/health                                   # -> ok
curl -s https://mcp.diagrams.so/.well-known/oauth-protected-resource      # resource + authorization_servers
curl -sD - -o /dev/null -X POST https://mcp.diagrams.so/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'  # -> 401 + WWW-Authenticate
```
Then add `https://mcp.diagrams.so/mcp` as a **custom connector** in Claude → Connect → consent →
Approve → `tools/list` → `generate_diagram`.

## 6. Rollback
`aws elasticbeanstalk update-environment --environment-name <mcp-eb-env> --version-label <previous>`
— or point DNS away / stop the env. The published npm package + stdio transport are untouched, so
`npx` users are unaffected.

## Notes
- The image is multi-stage (build compiles TS → `dist`; runtime ships prod deps + `dist` only) and
  runs as the non-root `node` user with a `/health` HEALTHCHECK.
- Stateless (`sessionIdGenerator: undefined`, JSON-response mode): any pod can serve any request,
  so horizontal scaling is trivial and deploys drain nothing.
