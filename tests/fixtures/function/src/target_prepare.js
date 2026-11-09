// @ts-check
import { CountryCode } from "../generated/api";

/**
 * @typedef {import("../generated/api").FunctionTargetPrepareResult} FunctionTargetPrepareResult
 * @typedef {import("../generated/api").TargetRunInputVariables} TargetRunInputVariables
 */

/** @returns {FunctionTargetPrepareResult} */
export function targetPrepare() {
  /** @type {TargetRunInputVariables} */
  const variables = { filter: { titles: ["Gift card"], country: CountryCode.Ca }, country: CountryCode.Us };
  return { variables };
}
