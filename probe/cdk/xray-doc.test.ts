import { describe, expect, it } from "vitest";
import {
  flattenDocs,
  parseXrayDoc,
  spanIdFromTraceparent,
  type XrayDoc,
  xrayDocContextSource,
  xrayDocLinked,
  xrayDocTraceLinked,
  xrayParentIdFromHeader,
  xrayTraceIdFromHeader,
  xrayTraceIdFromTraceparent,
} from "./xray-doc.js";

const TRACE_ID_HEX = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID_HEX = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID_HEX}-${SPAN_ID_HEX}-01`;

describe("xrayTraceIdFromTraceparent", () => {
  it("W3C traceparent を X-Ray trace id 形式へ変換する", () => {
    expect(xrayTraceIdFromTraceparent(TRACEPARENT)).toBe("1-4bf92f35-77b34da6a3ce929d0e0e4736");
  });
  it("大文字 hex も lowercase に正規化する", () => {
    expect(xrayTraceIdFromTraceparent(TRACEPARENT.toUpperCase())).toBe(
      "1-4bf92f35-77b34da6a3ce929d0e0e4736",
    );
  });
  it.each([undefined, "", "garbage", "00-xyz-00f067aa0ba902b7-01", `01-${TRACE_ID_HEX}`])(
    "不正入力 %j は undefined",
    (input) => {
      expect(xrayTraceIdFromTraceparent(input)).toBeUndefined();
    },
  );
});

describe("spanIdFromTraceparent", () => {
  it("span id を取り出す", () => {
    expect(spanIdFromTraceparent(TRACEPARENT)).toBe(SPAN_ID_HEX);
  });
  it("不正なら undefined", () => {
    expect(spanIdFromTraceparent("00-1234-5678-01")).toBeUndefined();
    expect(spanIdFromTraceparent(undefined)).toBeUndefined();
  });
});

describe("X-Ray header parsers", () => {
  const HEADER = "Root=1-4bf92f35-77b34da6a3ce929d0e0e4736;Parent=00f067aa0ba902b7;Sampled=1";
  it("Root / Parent を取り出す", () => {
    expect(xrayTraceIdFromHeader(HEADER)).toBe("1-4bf92f35-77b34da6a3ce929d0e0e4736");
    expect(xrayParentIdFromHeader(HEADER)).toBe("00f067aa0ba902b7");
  });
  it("欠損 header は undefined", () => {
    expect(xrayTraceIdFromHeader(undefined)).toBeUndefined();
    expect(xrayTraceIdFromHeader("Sampled=1")).toBeUndefined();
    expect(xrayParentIdFromHeader("Root=1-4bf92f35-77b34da6a3ce929d0e0e4736")).toBeUndefined();
  });
});

describe("parseXrayDoc", () => {
  it("正当な doc をそのまま返す", () => {
    const doc = parseXrayDoc(JSON.stringify({ id: "abc", trace_id: "1-aaaa-bb" }));
    expect(doc?.id).toBe("abc");
  });
  it.each([undefined, "", "{not json", "[1,2]", "null", '"s"', "5"])(
    "object でない / parse 不能な %j は undefined",
    (input) => {
      expect(parseXrayDoc(input)).toBeUndefined();
    },
  );
  it("links / subsegments が配列でない doc は捨てる", () => {
    expect(parseXrayDoc(JSON.stringify({ links: { id: "x" } }))).toBeUndefined();
    expect(parseXrayDoc(JSON.stringify({ subsegments: "oops" }))).toBeUndefined();
  });
});

describe("flattenDocs", () => {
  it("subsegments を深さ優先で平坦化する", () => {
    const docs: XrayDoc[] = [
      { id: "root", subsegments: [{ id: "child", subsegments: [{ id: "grand" }] }, { id: "c2" }] },
      { id: "sibling" },
    ];
    expect(flattenDocs(docs).map((d) => d.id)).toEqual(["root", "child", "grand", "c2", "sibling"]);
  });
});

describe("xrayDocLinked", () => {
  it("links[].id が producer spanId と一致すれば true", () => {
    const doc: XrayDoc = { links: [{ id: SPAN_ID_HEX }] };
    expect(xrayDocLinked(doc, SPAN_ID_HEX)).toBe(true);
  });
  it("parent_id 一致も true", () => {
    expect(xrayDocLinked({ parent_id: SPAN_ID_HEX }, SPAN_ID_HEX)).toBe(true);
  });
  it("links[].trace_id の一致だけでは true にしない（dead link 誤判定の防止）", () => {
    const doc: XrayDoc = { links: [{ trace_id: "1-4bf92f35-77b34da6a3ce929d0e0e4736" }] };
    expect(xrayDocLinked(doc, SPAN_ID_HEX)).toBe(false);
  });
  it("producerSpanId undefined は常に false", () => {
    expect(xrayDocLinked({ parent_id: "x" }, undefined)).toBe(false);
  });
});

describe("xrayDocTraceLinked", () => {
  const TRACE = "1-4bf92f35-77b34da6a3ce929d0e0e4736";
  it("links[].trace_id の一致で true（弱い証拠）", () => {
    expect(xrayDocTraceLinked({ links: [{ trace_id: TRACE }] }, TRACE)).toBe(true);
  });
  it("不一致・emitterTraceId undefined は false", () => {
    expect(xrayDocTraceLinked({ links: [{ trace_id: "1-other-other" }] }, TRACE)).toBe(false);
    expect(xrayDocTraceLinked({ links: [{ trace_id: TRACE }] }, undefined)).toBe(false);
  });
});

describe("xrayDocContextSource", () => {
  const KEY = "sekimori.context.source";
  it("annotations の素の文字列を読む", () => {
    expect(xrayDocContextSource({ annotations: { [KEY]: "eventbridge" } })).toBe("eventbridge");
  });
  it("StringValue 形の annotation を読む", () => {
    expect(xrayDocContextSource({ annotations: { [KEY]: { StringValue: "sqs" } } })).toBe("sqs");
  });
  it("annotations に無ければ metadata を見る", () => {
    expect(xrayDocContextSource({ metadata: { [KEY]: "kinesis" } })).toBe("kinesis");
  });
  it("doc undefined・key 不在・空文字は undefined", () => {
    expect(xrayDocContextSource(undefined)).toBeUndefined();
    expect(xrayDocContextSource({})).toBeUndefined();
    expect(xrayDocContextSource({ annotations: { [KEY]: "" } })).toBeUndefined();
  });
});
