/** SAM `Globals` の Function property merge 規則の実装。 */

import type { Json } from "./cfn.js";
import { asObject, isIntrinsicObject, isNoValueRef, isUnresolvable } from "./cfn.js";

/**
 * SAM `Globals.Function` に書ける property（doctor が読む分）。SAM はサポート外の key
 * （FunctionName / Role / Policies / PackageType / ImageConfig 等）を Globals に書くと
 * エラーまたは無視にする — 同じく適用しない。サポート一覧は samtranslator の
 * globals.py の Function supported_properties に揃える。
 */
const SAM_GLOBAL_KEYS = new Set([
  "Runtime",
  "Tracing",
  "Layers",
  "Environment",
  "PermissionsBoundary",
  "Tags",
  "VpcConfig",
  "Handler",
  "MemorySize",
  "Timeout",
  "Architectures",
  "KmsKeyArn",
  "DeadLetterQueue",
  "EventInvokeConfig",
  "LoggingConfig",
  "SnapStart",
  "EphemeralStorage",
  "ReservedConcurrentExecutions",
  "ProvisionedConcurrencyConfig",
  "RuntimeManagementConfig",
  "AssumeRolePolicyDocument",
  "FileSystemConfigs",
  "CodeUri",
  "Description",
  "PropagateTags",
  "AutoPublishAlias",
  "AutoPublishAliasAllProperties",
  "DeploymentPreference",
  "RolePath",
  "CodeSigningConfigArn",
  "FunctionUrlConfig",
  "RecursiveLoop",
  "SourceKMSKeyArn",
]);

/** Globals.Function が受け付けない key（= SAM が無視またはエラーにする key）の抽出。 */
export function unsupportedGlobalKeys(globalProps: Json | undefined): string[] {
  return Object.keys(globalProps ?? {}).filter((k) => !SAM_GLOBAL_KEYS.has(k));
}

/**
 * SAM Globals の merge 規則: scalar は function 側が勝つ、map（`Environment.Variables` 等）は
 * 再帰的に merge、list（`Layers` / `Policies` 等）は global 側を先に連結する。
 * intrinsic（`{Fn::If}` 等）は merge 不能 — 両側 object/list でも function 側を採る。
 * `Ref: AWS::NoValue` は未設定として相手側を残す。
 * 戻り値の `dropped` には、merge 不能で捨てた global 側の intrinsic key を集める —
 * 捨てた値の中身が分からないまま pass/fail しないよう、該当 check を warn に倒す。
 */
export function mergeSamGlobals(
  globalProps: Json,
  ownProps: Json,
): { props: Json; dropped: Set<string> } {
  const merged: Json = {};
  const dropped = new Set<string>();
  const keys = new Set([...Object.keys(globalProps), ...Object.keys(ownProps)]);
  for (const key of keys) {
    if (!SAM_GLOBAL_KEYS.has(key)) {
      // Globals 非対応 key は function 側にしか効かない。
      if (ownProps[key] !== undefined) merged[key] = ownProps[key];
      continue;
    }
    const gVal = globalProps[key];
    const oVal = ownProps[key];
    if (oVal === undefined || isNoValueRef(oVal)) {
      if (gVal !== undefined) merged[key] = gVal;
      continue;
    }
    if (gVal === undefined || isNoValueRef(gVal)) {
      merged[key] = oVal;
      continue;
    }
    const gObj = asObject(gVal);
    const oObj = asObject(oVal);
    if (
      gObj !== undefined &&
      oObj !== undefined &&
      !isIntrinsicObject(gObj) &&
      !isIntrinsicObject(oObj)
    ) {
      // nested map（`Environment.Variables` 等）— SAM_GLOBAL_KEYS は top-level 専用なので
      // ここでは filter せず全 key を merge する。
      const sub = mergeJsonObjects(gObj, oObj);
      merged[key] = sub.merged;
      if (sub.dropped) dropped.add(key);
    } else if (Array.isArray(gVal) && Array.isArray(oVal)) {
      merged[key] = [...gVal, ...oVal];
    } else {
      if (isUnresolvable(gVal)) dropped.add(key);
      merged[key] = oVal;
    }
  }
  return { props: merged, dropped };
}

/** nested map の merge — scalar は own 優先、list は global 先行、map は再帰。 */
function mergeJsonObjects(globalObj: Json, ownObj: Json): { merged: Json; dropped: boolean } {
  const merged: Json = {};
  let dropped = false;
  const keys = new Set([...Object.keys(globalObj), ...Object.keys(ownObj)]);
  for (const key of keys) {
    const gVal = globalObj[key];
    const oVal = ownObj[key];
    if (oVal === undefined || isNoValueRef(oVal)) {
      if (gVal !== undefined) merged[key] = gVal;
      continue;
    }
    if (gVal === undefined || isNoValueRef(gVal)) {
      merged[key] = oVal;
      continue;
    }
    const gSub = asObject(gVal);
    const oSub = asObject(oVal);
    if (
      gSub !== undefined &&
      oSub !== undefined &&
      !isIntrinsicObject(gSub) &&
      !isIntrinsicObject(oSub)
    ) {
      const sub = mergeJsonObjects(gSub, oSub);
      merged[key] = sub.merged;
      dropped ||= sub.dropped;
    } else if (Array.isArray(gVal) && Array.isArray(oVal)) {
      merged[key] = [...gVal, ...oVal];
    } else {
      if (isUnresolvable(gVal)) dropped = true;
      merged[key] = oVal;
    }
  }
  return { merged, dropped };
}
