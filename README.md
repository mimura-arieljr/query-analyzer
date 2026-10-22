# Query Analyzer

Paste a PostgreSQL, MySQL or CloudWatch Logs Insights query and get a plain-language explanation plus findings for danger, security and performance. A rules layer checks the query text itself, so the danger warnings (for example a `DELETE` with no `WHERE`) do not depend on the model getting it right. Nothing is stored. Each person deploys their own copy as one stack in their own AWS account.

## How it works

- The web page is a static site in S3, served by CloudFront.
- CloudFront sends `/api/*` to a Lambda function URL, using origin access control (the function URL is not open to the internet directly).
- The Lambda function runs the rules, then calls Amazon Bedrock (Converse API) to explain the query.
- A shared secret in Secrets Manager protects the API. You type it into the unlock box on the page.

## Prerequisites

- Node 22 or newer.
- AWS credentials for the target account in your shell.
- One-time CDK bootstrap. The stack is fixed to `ap-southeast-2`, so bootstrap that region:

```sh
npx cdk bootstrap aws://<account-id>/ap-southeast-2
```

- An email address for the budget alert.

## One-time Bedrock setup (per model)

The CDK stack cannot do these steps. You do them by hand, once per model, in the target account. The stack calls Claude Haiku 4.5 by default. Until all three are done, calls fail.

1. Submit the Anthropic first-time-use form in the Bedrock console.
2. Make sure the per-model Marketplace agreement is `AVAILABLE`:

```sh
aws bedrock get-foundation-model-availability \
  --model-id anthropic.claude-haiku-4-5-20251001-v1:0 \
  --region ap-southeast-2
```

If the agreement is not available, it can be created with the `ListFoundationModelAgreementOffers` and `CreateFoundationModelAgreement` APIs. Creating it accepts the provider's terms on behalf of the account, so read the offer first.

3. In Service Quotas, check that the model's tokens per minute quota is above 0 in `ap-southeast-2`. New models can ship with a quota of 0, and calls then fail with `AccessDeniedException ... not available for this account`.

### Switching to another model

For each model you want to use, repeat this checklist:

- Its own first-time-use form and Marketplace agreement.
- Its own tokens per minute quota above 0.
- Support for structured output through the Converse API. If it has none, try `-c outputMode=tool` or `-c outputMode=json` (see the settings table).
- Deploy, then run a few test queries before relying on it.

## `global.` or `au.` inference profile

The default inference profile id is `global.anthropic.claude-haiku-4-5-20251001-v1:0`.

- `global.` (default): Bedrock may process a pasted query in any commercial AWS region. There is no data-residency promise. It is about 10% cheaper. Logs and data at rest stay in `ap-southeast-2`. It can fail where an AWS Organizations policy blocks other regions.
- `au.`: processing stays in `ap-southeast-2` and `ap-southeast-4`.

To use `au.`, add this to the deploy command. The foundation model id does not change.

```sh
-c inferenceProfileId=au.anthropic.claude-haiku-4-5-20251001-v1:0
```

## Deploy

```sh
npm install
npm run deploy -- -c budgetEmail=you@example.com
```

`npm run deploy` builds the web app and then runs `cdk deploy` in `packages/infra`. Everything after `--` goes to `cdk deploy`. The first deploy takes several minutes. When it finishes, the outputs show `SiteUrl` and `SecretName`.

### Settings

Pass each one as `-c name=value`. Only `budgetEmail` is required.

| Setting | Default | Meaning |
| --- | --- | --- |
| `budgetEmail` | none (required) | Email that receives the budget alert. |
| `inferenceProfileId` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Bedrock inference profile the function calls. |
| `foundationModelId` | `anthropic.claude-haiku-4-5-20251001-v1:0` | Underlying model, used for the IAM permission. |
| `maxTokens` | `4096` | Maximum output tokens per call. |
| `outputMode` | `structured` | How the model returns JSON: `structured`, `tool` or `json`. |
| `concurrencyCap` | `5` | Reserved Lambda concurrency. `0` means no reservation. |
| `budgetUsd` | `5` | Monthly budget amount in USD. |
| `logRetentionDays` | `14` | Lambda log retention. Must be a value CloudWatch Logs supports. |
| `temperature` | not set | Sampling temperature. If not set, the model default applies. |

### If the deploy fails on Lambda concurrency

New AWS accounts have a Lambda concurrency limit of 10. Lambda does not let a function reserve concurrency if fewer than 10 would stay unreserved. With the default `concurrencyCap=5`, the deploy fails in such an account with an error about the unreserved concurrency minimum.

Check your limit:

```sh
aws lambda get-account-settings
```

Two fixes:

- Request a Lambda "Concurrent executions" quota increase of at least 100 in Service Quotas, then deploy again.
- Or deploy with `-c concurrencyCap=0`. This reserves nothing, and the account limit then acts as the cap.

```sh
npm run deploy -- -c budgetEmail=you@example.com -c concurrencyCap=0
```

## First use

1. In the AWS console, open Secrets Manager, find the secret `query-analyzer-shared-secret`, and choose "Retrieve secret value". Do this once.
2. Open the `SiteUrl` from the deploy outputs and type the secret into the unlock box.

The page keeps the secret in memory only, so a refresh asks for it again. Never paste the secret into chats or scripts.

To rotate it, change the value in Secrets Manager (or delete the secret and redeploy) and use the new value.

The first request after a deploy can be slow, because the output format is compiled once and cached for about 24 hours. Later calls take roughly 3 to 17 seconds.

## Cost

- Secrets Manager: about $0.40 per month.
- Bedrock with Haiku: about $0.006 per question (about 3,000 input tokens and 600 to 1,150 output tokens, at $1 and $5 per million tokens). These prices were checked on the Marketplace rate card. Verify current prices.
- CloudFront, S3 and Lambda: pennies at personal volume.
- The stack adds a monthly budget of $5 with an alert at 80% of actual spend, sent to the email you gave. The budget covers the whole account, and budget alerts lag billing data by hours. The concurrency cap is the real brake.

## What is logged

- Lambda logs hold one metadata line per analyze call: inference profile, token counts, latency, rule IDs and error code. They are kept for 14 days by default.
- The pasted query, the answer and the secret are never logged.
- Bedrock model invocation logging is off by default. Keep it off, because it would record queries and answers.
- There is no database. Nothing is stored.
- Known small gap: the log group of the BucketDeployment helper function is created by CDK without a retention period.

## Removing it

```sh
cd packages/infra
npx cdk destroy
```

- The site bucket is retained by design. Empty and delete it by hand.
- The secret may stay scheduled for deletion for a recovery window. Check the console before redeploying with the same name.

## Known limits

- The rules are pattern matching on text, not a SQL parser.
- SQL hidden in dynamic strings built at runtime, or run through `EXECUTE`, is not analysed by the rules.
- Rewrites are dropped for statements that change data, except parameterizing string-built SQL. Wrapped driver calls are dropped too.
- Other languages are explained best-effort by the model, without the rule checks.
- The model can be wrong. Treat results as a review aid.

## Development

```sh
npm test
npm run typecheck
```
