# evidence

`probe/cdk/assert.ts` が書く trace connectivity report の置き場です。生成された JSON は
`.gitignore` で除外され、CI では workflow の artifact として保存する予定です。
古い証跡は自動で pruning されます（保持件数は `SEKIMORI_PROBE_EVIDENCE_KEEP`、default 30）。
