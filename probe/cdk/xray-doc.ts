/**
 * X-Ray trace document の純粋な判定層 — doc 型・id 抽出・link 判定・
 * 平坦化を置く。AWS 呼び出し（fetch / poll）は xray-fallback.ts 側。
 */

export interface XrayDoc {
  id?: string;
  name?: string;
  trace_id?: string;
  parent_id?: string;
  links?: { trace_id?: string; id?: string }[];
  subsegments?: XrayDoc[];
  // OTel span 属性は ADOT 経由で annotations（index 対象）または metadata に転記される。
  annotations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function xrayTraceIdFromTraceparent(traceparent: string | undefined): string | undefined {
  const m = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(traceparent ?? "");
  if (!m) return undefined;
  const hex = (m[1] ?? "").toLowerCase();
  return `1-${hex.slice(0, 8)}-${hex.slice(8)}`;
}

/** traceparent から spanId（inject した span そのもの）を取り出す。 */
export function spanIdFromTraceparent(traceparent: string | undefined): string | undefined {
  return /^00-[0-9a-f]{32}-([0-9a-f]{16})-[0-9a-f]{2}$/i
    .exec(traceparent ?? "")?.[1]
    ?.toLowerCase();
}

export function xrayTraceIdFromHeader(header: string | undefined): string | undefined {
  return /Root=(1-[0-9a-f]{8}-[0-9a-f]{24})/i.exec(header ?? "")?.[1]?.toLowerCase();
}

/** X-Ray header の `Parent=` — inject した span 自身の id（`traceparent` の spanId と同じ相関値）。 */
export function xrayParentIdFromHeader(header: string | undefined): string | undefined {
  return /Parent=([0-9a-f]{16})/i.exec(header ?? "")?.[1]?.toLowerCase();
}

/**
 * BatchGetTraces の Segment.Document（外部 JSON 文字列）を XrayDoc へ検証付きで parse する。
 * object でない / parse 失敗 / links・subsegments が配列でない doc は undefined —
 * downstream の `.some` / 再帰走査が壊れた doc で落ちないよう container field を検証する。
 */
export function parseXrayDoc(document: string | undefined): XrayDoc | undefined {
  if (document === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  const malformed =
    ("links" in o && o.links !== undefined && !Array.isArray(o.links)) ||
    ("subsegments" in o && o.subsegments !== undefined && !Array.isArray(o.subsegments));
  return malformed ? undefined : (o as XrayDoc);
}

export function flattenDocs(docs: XrayDoc[]): XrayDoc[] {
  const out: XrayDoc[] = [];
  const walk = (d: XrayDoc) => {
    out.push(d);
    for (const sub of d.subsegments ?? []) walk(sub);
  };
  for (const d of docs) walk(d);
  return out;
}

/**
 * consumer の X-Ray doc が emitter の producer span に繋がるか（厳密判定）。
 * `links[].id === producerSpanId`（emitter が response で返した traceparent の spanId
 * = inject した span そのもの）または `parent_id === producerSpanId` のときのみ true。
 * `links[].trace_id` 一致だけでは認めない — emitter trace 内の別 span（AWS 中継 node 等）
 * への dead link を linked と誤判定するため。trace 単位の一致は `xrayDocTraceLinked` が
 * 弱い証拠として別途記録する。
 */
export function xrayDocLinked(consumer: XrayDoc, producerSpanId: string | undefined): boolean {
  return (
    producerSpanId !== undefined &&
    ((consumer.links ?? []).some((l) => l.id === producerSpanId) ||
      consumer.parent_id === producerSpanId)
  );
}

/**
 * X-Ray doc から `sekimori.context.source`（context が来た carrier）を拾う。
 * ADOT は span 属性を annotations か metadata に転記する — 両方を見る。
 */
export function xrayDocContextSource(consumer: XrayDoc | undefined): string | undefined {
  if (consumer === undefined) return undefined;
  for (const bag of [consumer.annotations, consumer.metadata]) {
    const v = bag?.["sekimori.context.source"];
    if (typeof v === "string" && v !== "") return v;
    if (v !== null && typeof v === "object" && "StringValue" in v) {
      // annotations は { StringValue: "..." } の形で返ることがある
      const sv = v.StringValue;
      if (typeof sv === "string" && sv !== "") return sv;
    }
  }
  return undefined;
}

/**
 * consumer doc が emitter trace 内の「何らかの span」へ link を持つか（弱い証拠）。
 * link 先 span が producer span と特定できないケース（Transaction Search の links 未転記、
 * AWS 中継 node 経由）の切り分け用。`linked` の判定には使わない。
 */
export function xrayDocTraceLinked(consumer: XrayDoc, emitterTraceId: string | undefined): boolean {
  return (
    emitterTraceId !== undefined &&
    (consumer.links ?? []).some((l) => l.trace_id === emitterTraceId)
  );
}
