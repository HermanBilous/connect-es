import { StatusCode } from "./status-code.js";
import type { Any } from "@bufbuild/protobuf";

// TODO "procedure" - service / method name would be convenient to have her
// TODO nest errors á la https://github.com/Veetaha/ts-nested-error/blob/master/src/nested-error.ts ?

type ErrorCode = Exclude<StatusCode, StatusCode.Ok>;

export class ConnectError extends Error {
  readonly code: ErrorCode;
  readonly details: Any[];
  override name = "ConnectError";

  constructor(
    message: string,
    code: ErrorCode = StatusCode.Unknown,
    details?: Any[]
  ) {
    super(`[${StatusCode[code]}] ${message}`);
    // see https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html#example
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
    this.details = details ?? [];
  }
}
