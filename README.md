# Query Analyzer

Paste a PostgreSQL, MySQL or CloudWatch Logs Insights query and get a plain-language explanation plus findings for danger, security and performance. A rules layer checks the SQL text itself, so the danger warnings (for example a `DELETE` with no `WHERE`) do not depend on the model getting it right. When the paste looks like application code, the rules also check SQL in its string literals. SQL assembled at runtime from parts, or run through `EXECUTE`, is not analysed by the rules. Nothing is stored. Each person deploys their own copy as one stack in their own AWS account.

## How it works

- The web page is a static site in S3, served by CloudFront.
- CloudFront sends `/api/*` to a Lambda function URL, using origin access control (the function URL is not open to the internet directly).
- The Lambda function calls Amazon Bedrock (Converse API) to explain the query, then merges the reply with the rule findings. See [How the rules and the model work together](#how-the-rules-and-the-model-work-together).
- A shared secret in Secrets Manager protects the API. You type it into the unlock box on the page.

### Sample model reply

This is the JSON Bedrock returns for a PostgreSQL query with `$client` and `$ap_queues` placeholders. The Lambda function checks it against the schema, then merges in the rule findings before sending it to the page.

```json
{
  "is_query": true,
  "not_a_query_message": "",
  "query_type": {
    "language": "postgresql",
    "dialect_note": "This looks like PostgreSQL. EXTRACT(EPOCH FROM ...) and the ::int cast are PostgreSQL syntax, and MySQL does not support them in this form. The $client and $ap_queues parts look like placeholders that a tool (for example a dashboard) fills in before the query runs. The \\\" and \\n in the pasted text look like escape characters from the string the query was copied from, not part of the SQL itself.",
    "confidence": "high"
  },
  "what_it_does": "Calculates the average number of seconds that voice contacts have been waiting in the chosen queues, counting only contacts that are still waiting for an agent. It returns 0 if no contacts match.",
  "detailed_explanation": "1) FROM/JOIN: it reads contact_records_realtime (alias crr) and matches each row to queue_configuration (alias qc) where both queue_id and client are equal. 2) WHERE: it keeps only rows where the client equals the $client value, the channel is 'VOICE', and the queue name is in the $ap_queues list. It also requires an enqueued time to be set, no connected_to_agent time (nobody has answered yet) and no disconnect time (the contact has not ended). Together, these mean the contact is still waiting. 3) SELECT: for each remaining row it subtracts the enqueued time from the current time, which gives an interval. EXTRACT(EPOCH FROM ...) turns that into seconds. AVG takes the mean of those seconds across all remaining rows. ::int converts the mean to a whole number, which rounds it. COALESCE replaces an empty result (NULL, when no rows match) with 0. The column is labelled \"Wait Time AVG\". There is no GROUP BY, so the result is a single row. There is no ORDER BY or LIMIT.",
  "simple_explanation": "It looks at phone calls that are still waiting in line for the chosen queues and works out how long, on average, they have been waiting, in whole seconds. If nobody is waiting, it shows 0.",
  "step_by_step": [
    {
      "snippet": "FROM contact_records_realtime crr",
      "explanation": "Start with the table of live contact records."
    },
    {
      "snippet": "JOIN queue_configuration qc ON qc.queue_id = crr.queue_id AND qc.client = crr.client",
      "explanation": "Attach each contact's queue settings (such as the queue name), matching on both queue and client."
    },
    {
      "snippet": "WHERE crr.client = '$client'",
      "explanation": "Keep only contacts for one client, using the value the tool substitutes for $client."
    },
    {
      "snippet": "AND crr.channel = 'VOICE'",
      "explanation": "Keep only voice contacts."
    },
    {
      "snippet": "AND qc.name IN ($ap_queues)",
      "explanation": "Keep only contacts whose queue name is in the list substituted for $ap_queues."
    },
    {
      "snippet": "AND crr.enqueued IS NOT NULL",
      "explanation": "Keep only contacts that have a time recorded for entering the queue."
    },
    {
      "snippet": "AND crr.connected_to_agent IS NULL",
      "explanation": "Keep only contacts not yet connected to an agent."
    },
    {
      "snippet": "AND crr.disconnect IS NULL",
      "explanation": "Keep only contacts that have not ended."
    },
    {
      "snippet": "EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - crr.enqueued))",
      "explanation": "For each remaining contact, work out the time since it entered the queue, in seconds."
    },
    {
      "snippet": "AVG(...)::int",
      "explanation": "Average those wait times across all remaining contacts, then convert the result to a whole number."
    },
    {
      "snippet": "COALESCE(..., 0) AS \"Wait Time AVG\"",
      "explanation": "Show 0 instead of NULL when no contacts match, and name the output column \"Wait Time AVG\"."
    }
  ],
  "improvements": [
    "The values for $client and $ap_queues are placed directly into the SQL text. If your tool supports bound parameters, use them instead (in PostgreSQL, a list can be passed as an array and matched with = ANY(...)). This is safer and avoids quoting problems.",
    "COALESCE(..., 0) makes 'nobody is waiting' look the same as 'average wait is 0 seconds'. If those need to be told apart, return NULL, or add COUNT(*) as a second column.",
    "If queue_configuration could hold more than one row for the same queue_id and client, the join would repeat contacts and skew the average. Check that the pair is unique in that table, which you can do by looking at its definition."
  ],
  "rewritten_query": {
    "query": "",
    "reason": ""
  },
  "security": {
    "level": "medium",
    "findings": [
      {
        "reason": "$client (inside quotes) and $ap_queues (in an IN list, not quoted by the query) look like values the tool inserts as plain text before the query runs. If either value can be typed or influenced by a user, it could change the meaning of the query (SQL injection) or expose data the user should not see.",
        "certainty": "possible",
        "assumption": "The $client and $ap_queues values are substituted as plain text and can be influenced by a user, for example through free-text inputs, rather than coming from a fixed, trusted list.",
        "how_to_verify": "In the tool that runs this query, check how the $client and $ap_queues variables are defined: a fixed list or a query-driven list is much safer than free text. Also check that the database account used only has SELECT permission, by inspecting its grants (for example by querying information_schema.role_table_grants for that role)."
      }
    ]
  },
  "danger": {
    "level": "none",
    "can_change_data": "no",
    "data_change_summary": "Nothing can change: this is a plain SELECT that only reads data.",
    "findings": []
  },
  "performance": {
    "level": "none",
    "findings": []
  }
}
```

## How the rules and the model work together

Two independent checks look at the same query, and the result is a merge of both. The answer does not rest on the model alone.

| | Model (Bedrock) | Rules (`packages/core/src/rules`) |
| --- | --- | --- |
| Good at | Explaining the query, step by step, and judging context (for example, "this looks like a placeholder a tool fills in") | Spotting known risky patterns the same way every time |
| Weak at | Can miss a risk, or call one a non-issue | Only knows the patterns written into it; cannot explain anything |
| Output | The whole reply: explanation, steps, findings, rewrite | Findings only |

```
query ──► Bedrock model ──► model reply ──┐
  │                                       ├──► finalize ──► response
  └─────► rules (regex checks) ──► hits ──┘
```

The two never see each other's work until the merge. The model gets only the query and the prompt, and the rules get only the query text.

### What the merge does

- Each category (danger, security, performance) takes the higher of the model's level and any rule's level.
- A rule finding is added to the model's findings. If the model already reported the same certain finding, the model's copy is dropped so it is not listed twice.
- A rule that finds a data change sets "can change data" to yes, even if the model said no.
- If the model says the text is not a query but the rules find danger, a data change or string-built SQL, the rules win and the findings are shown.
- A Logs Insights query is shown as read-only, but only when no rule found a risk. This is the only case where the rules lower a warning.
- The model's rewritten query is dropped when it is no safer than the original, or when the original changes data.

The merge lives in `packages/core/src/finalize.ts`. The explanation text still comes from the model alone, so it can be wrong. The rules make sure the warnings do not depend on it.

### Improving the results

- **Add a rule** when the model keeps missing a risk, or a warning must never depend on the model:
  1. Add the id to `RuleId` in `packages/core/src/rules/types.ts`.
  2. Define the rule with `certainRule` or `possibleRule` in a file under `packages/core/src/rules/definitions`.
  3. Add it to `RULES` in `packages/core/src/rules/registry.ts`.
  4. Add tests in `packages/core/test`.
- **Use a better model** when the explanations or the context-based findings are weak. See [Switching to another model](#switching-to-another-model).

## Prerequisites

- Node 22 or newer.
- AWS credentials for the target account in your shell.
- An email address for the budget alert.
- Dependencies installed, then a one-time CDK bootstrap. Run both from the repo root. The stack is fixed to `ap-southeast-2`, so bootstrap that region:

```sh
npm install
npx cdk bootstrap aws://<account-id>/ap-southeast-2
```

### Check Lambda concurrency first

The stack reserves Lambda concurrency (`concurrencyCap`, default 5) as a spend brake. Lambda keeps a minimum unreserved pool for the account, so an account with a low concurrency limit cannot reserve any, and the default deploy then fails. New accounts may have a low limit: the account used while building this project had 10. See the Lambda docs on reserved concurrency for the exact rule.

Check your limit before the first deploy (look at `AccountLimit.ConcurrentExecutions`):

```sh
aws lambda get-account-settings --region ap-southeast-2
```

If it is low, pick one:

- Request a Lambda "Concurrent executions" quota increase in Service Quotas, and wait for it before deploying. The usual default is 1,000.
- Or deploy with `-c concurrencyCap=0`. This reserves nothing, and the account limit is then the only cap. Record it in `cdk.json` so later deploys keep it (see [Remembering settings](#remembering-settings)).

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

To use `au.`, add this to every deploy command, or record it once in `cdk.json` (see [Remembering settings](#remembering-settings)). A later deploy without it moves the stack back to `global.`. The foundation model id does not change.

```sh
-c inferenceProfileId=au.anthropic.claude-haiku-4-5-20251001-v1:0
```

## Deploy

From the repo root (run `npm install` first if you have not):

```sh
npm run deploy -- -c budgetEmail=you@example.com
```

**`-c` values are not remembered between deploys. Pass the same ones every time, or record them in `packages/infra/cdk.json` (see [Remembering settings](#remembering-settings)). Otherwise a later deploy silently goes back to the defaults, for example `global.` processing and `concurrencyCap=5`.**

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

### Remembering settings

A `-c` value applies to that one command only. CDK does not store it, so the next deploy without it uses the default again. To keep your settings, add them to the `context` block of `packages/infra/cdk.json`. CDK reads that file on every synth, deploy and destroy, and a `-c` value on the command line still overrides it. Keep the existing `app` and `output` lines:

```json
{
  "app": "npx tsx bin/app.ts",
  "output": "cdk.out",
  "context": {
    "budgetEmail": "you@example.com",
    "inferenceProfileId": "au.anthropic.claude-haiku-4-5-20251001-v1:0",
    "concurrencyCap": "0"
  }
}
```

Then `npm run deploy` needs no `-c` values. Numbers can be written as `"0"` or `0`. `cdk.json` is tracked by git, so do not commit your real email to a public repo. Keep the change local, or use a private fork.

### If the deploy fails on Lambda concurrency

With the default `concurrencyCap=5` on an account with a low concurrency limit, the deploy fails with an error that mentions unreserved concurrency. See [Check Lambda concurrency first](#check-lambda-concurrency-first) for the check and the two ways out. For example:

```sh
npm run deploy -- -c budgetEmail=you@example.com -c concurrencyCap=0
```

## First use

1. In the AWS console, open Secrets Manager, find the secret `query-analyzer-shared-secret`, and choose "Retrieve secret value". Do this once.
2. Open the `SiteUrl` from the deploy outputs and type the secret into the unlock box.

The page keeps the secret in memory only, so a refresh asks for it again. Never paste the secret into chats or scripts.

### Rotating the secret

- Change the value in the Secrets Manager console (region `ap-southeast-2`).
- The function reads the secret once per Lambda container and caches it. Warm containers keep accepting the old value until they are replaced.
- To force the replacement, run a deploy that changes the function, for example a different `-c maxTokens` or `-c temperature` value, or any code change.
- Then test with both the old and the new value. This sequence has not been verified end to end.
- Deleting the secret and redeploying does not regenerate it, and the name stays reserved during the deletion window.

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

`cdk destroy` loads the same app as deploy, so it needs `budgetEmail` and the built web app. `packages/web/dist` is git-ignored and missing on a fresh clone, so build it first if needed:

```sh
npm run build -w @qa/web
cd packages/infra
npx cdk destroy -c budgetEmail=you@example.com
```

Use the same `-c` values you used for deploy, unless they are recorded in `cdk.json`.

- The site bucket is retained by design. Empty and delete it by hand.
- The secret may stay scheduled for deletion for a recovery window. Check the console before redeploying with the same name.

## Known limits

- The rules are pattern matching on text, not a SQL parser.
- The rules analyse SQL text, including SQL in the string literals of application code when the paste looks like code. SQL assembled at runtime from parts, or run through `EXECUTE`, is not analysed by the rules.
- Rewrites are dropped for statements that change data, except parameterizing string-built SQL. Wrapped driver calls are dropped too.
- Other languages are explained best-effort by the model, without the rule checks.
- The model can be wrong. Treat results as a review aid.

## Development

```sh
npm test
npm run typecheck
```
