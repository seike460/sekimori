# @sekimori/probe

emitter → EventBridge → SQS → consumer の恒久的な統合経路です。両 Lambda は ADOT layer で計装し、
consumer は record ごとに `withSqsRecord` の CONSUMER span を開きます。`assert.ts` が Transaction Search の
span を probe_id で検索し、consumer span が emitter へ link を持つことを確かめ、`docs/evidence/` に報告を残します。

```bash
# すべてリポジトリ root から実行する（pnpm -w で workspace root の script を指す）。
pnpm -w run build                            # sekimori 本体を先に build（bundler が dist を読む）
pnpm --filter @sekimori/probe run synth      # 資格情報不要。CI でも実行
pnpm --filter @sekimori/probe run deploy     # 実 AWS。課金あり
pnpm --filter @sekimori/probe run assert     # link を確認（最悪ケース約 30 分）
pnpm --filter @sekimori/probe run destroy
```

`assert` は最悪で約 30 分掛かる（Transaction Search の poll 15 分 + 見つからないときの
X-Ray fallback 15 分）。実行 principal には `lambda:InvokeFunction`、`logs:StartQuery` /
`logs:GetQueryResults`（log group `aws/spans`）、`xray:GetTraceSummaries` /
`xray:BatchGetTraces` が必要です。

`assert` は `SEKIMORI_PROBE_REGION` → `AWS_REGION` → AWS SDK の default chain の順で region を
決めます。deploy と別 region の資格情報・環境で実行するときは `SEKIMORI_PROBE_REGION` を明示
してください（`CDK_DEFAULT_REGION` は `cdk` CLI が app サブプロセスにだけ注入する値で、
後から叩く `assert` には渡りません）。

Transaction Search が未設定の account では `-c sekimori:transactionSearch=true` を付けて deploy します。
