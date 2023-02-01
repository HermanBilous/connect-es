// Copyright 2021-2023 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  Code,
  Compression,
  ConnectError,
  createAsyncIterable,
  createMethodSerializationLookup,
  createMethodUrl,
  createWritableIterable,
  Interceptor,
  pipe,
  pipeTo,
  runStreaming,
  runUnary,
  StreamingConn,
  StreamingRequest,
  transformCompressEnvelope,
  transformDecompressEnvelope,
  transformJoinEnvelopes,
  transformNormalizeMessage,
  transformParseEnvelope,
  transformSerializeEnvelope,
  transformSplitEnvelope,
  Transport,
  UnaryRequest,
  UnaryResponse,
} from "@bufbuild/connect-core";
import {
  createRequestHeaderWithCompression,
  createTrailerSerialization,
  trailerFlag,
  validateResponseWithCompression,
  validateTrailer,
} from "@bufbuild/connect-core/protocol-grpc-web";
import type {
  AnyMessage,
  BinaryReadOptions,
  BinaryWriteOptions,
  JsonReadOptions,
  JsonWriteOptions,
  Message,
  MethodInfo,
  PartialMessage,
  ServiceType,
} from "@bufbuild/protobuf";
import type { ReadableStreamReadResultLike } from "./lib.dom.streams.js";
import { defer } from "./private/defer.js";
import type {
  NodeHttp1TransportOptions,
  NodeHttp2TransportOptions,
} from "./node-transport-options.js";
import { validateNodeTransportOptions } from "./node-transport-options.js";

/**
 * Options used to configure the gRPC-web transport.
 *
 * See createGrpcWebTransport().
 */
type GrpcWebTransportOptions = (
  | NodeHttp1TransportOptions
  | NodeHttp2TransportOptions
) & {
  /**
   * Base URI for all HTTP requests.
   *
   * Requests will be made to <baseUrl>/<package>.<service>/method
   *
   * Example: `baseUrl: "https://example.com/my-api"`
   *
   * This will make a `POST /my-api/my_package.MyService/Foo` to
   * `example.com` via HTTPS.
   */
  baseUrl: string;

  /**
   * By default, clients use the binary format for gRPC-web, because
   * not all gRPC-web implementations support JSON.
   */
  useBinaryFormat?: boolean;

  /**
   * Interceptors that should be applied to all calls running through
   * this transport. See the Interceptor type for details.
   */
  interceptors?: Interceptor[];

  /**
   * Options for the JSON format.
   */
  jsonOptions?: Partial<JsonReadOptions & JsonWriteOptions>;

  /**
   * Options for the binary wire format.
   */
  binaryOptions?: Partial<BinaryReadOptions & BinaryWriteOptions>;

  // TODO document
  acceptCompression?: Compression[];
  sendCompression?: Compression;
  compressMinBytes?: number;
  readMaxBytes?: number;
  writeMaxBytes?: number;

  keepSessionAlive?: boolean;
};

/**
 * Create a Transport for the gRPC-web protocol using the Node.js `http`,
 * `http2`, or `http2` module.
 */
export function createGrpcWebTransport(
  options: GrpcWebTransportOptions
): Transport {
  const opt = validateNodeTransportOptions(options);
  return {
    async unary<
      I extends Message<I> = AnyMessage,
      O extends Message<O> = AnyMessage
    >(
      service: ServiceType,
      method: MethodInfo<I, O>,
      signal: AbortSignal | undefined,
      timeoutMs: number | undefined,
      header: HeadersInit | undefined,
      message: PartialMessage<I>
    ): Promise<UnaryResponse<O>> {
      const serialization = createMethodSerializationLookup(
        method,
        options.binaryOptions,
        options.jsonOptions
      );
      return await runUnary<I, O>(
        {
          stream: false,
          service,
          method,
          url: createMethodUrl(options.baseUrl, service, method),
          init: {},
          header: createRequestHeaderWithCompression(
            opt.useBinaryFormat,
            timeoutMs,
            header,
            opt.acceptCompression,
            opt.sendCompression
          ),
          message:
            message instanceof method.I ? message : new method.I(message),
          signal: signal ?? new AbortController().signal,
        },
        async (req: UnaryRequest<I>): Promise<UnaryResponse<O>> => {
          const universalResponse = await opt.client({
            url: req.url,
            method: "POST",
            header: req.header,
            body: pipe(
              createAsyncIterable([req.message]),
              transformSerializeEnvelope(
                serialization.getI(opt.useBinaryFormat),
                opt.writeMaxBytes
              ),
              transformCompressEnvelope(
                opt.sendCompression,
                opt.compressMinBytes
              ),
              transformJoinEnvelopes(),
              {
                propagateDownStreamError: true,
              }
            ),
            signal: req.signal,
          });
          const { compression } = validateResponseWithCompression(
            opt.useBinaryFormat,
            opt.acceptCompression,
            universalResponse.status,
            universalResponse.header
          );
          const { trailer, message } = await pipeTo(
            universalResponse.body,
            transformSplitEnvelope(opt.readMaxBytes),
            transformDecompressEnvelope(compression ?? null, opt.readMaxBytes),
            transformParseEnvelope<O, Headers>(
              serialization.getO(opt.useBinaryFormat),
              trailerFlag,
              createTrailerSerialization()
            ),
            async (iterable) => {
              let message: O | undefined;
              let trailer: Headers | undefined;
              for await (const env of iterable) {
                if (env.end) {
                  if (trailer !== undefined) {
                    throw new ConnectError(
                      "protocol error: received extra trailer",
                      Code.InvalidArgument
                    );
                  }
                  trailer = env.value;
                } else {
                  if (message !== undefined) {
                    throw new ConnectError(
                      "protocol error: received extra output message for unary method",
                      Code.InvalidArgument
                    );
                  }
                  message = env.value;
                }
              }
              return { trailer, message };
            },
            {
              propagateDownStreamError: false,
            }
          );
          if (trailer === undefined) {
            throw new ConnectError(
              "protocol error: missing trailer",
              Code.InvalidArgument
            );
          }
          validateTrailer(trailer);
          if (message === undefined) {
            throw new ConnectError(
              "protocol error: missing output message for unary method",
              Code.InvalidArgument
            );
          }
          return <UnaryResponse<O>>{
            stream: false,
            service,
            method,
            header: universalResponse.header,
            message,
            trailer,
          };
        },
        options.interceptors
      );
    },
    async stream<
      I extends Message<I> = AnyMessage,
      O extends Message<O> = AnyMessage
    >(
      service: ServiceType,
      method: MethodInfo<I, O>,
      signal: AbortSignal | undefined,
      timeoutMs: number | undefined,
      header: HeadersInit | undefined
    ): Promise<StreamingConn<I, O>> {
      const serialization = createMethodSerializationLookup(
        method,
        options.binaryOptions,
        options.jsonOptions
      );
      return runStreaming<I, O>(
        {
          stream: true,
          service,
          method,
          url: createMethodUrl(options.baseUrl, service, method),
          init: {
            method: "POST",
            redirect: "error",
            mode: "cors",
          },
          signal: signal ?? new AbortController().signal,
          header: createRequestHeaderWithCompression(
            opt.useBinaryFormat,
            timeoutMs,
            header,
            opt.acceptCompression,
            opt.sendCompression
          ),
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async (req: StreamingRequest<I, O>) => {
          const writable = createWritableIterable<PartialMessage<I>>();
          const universalResponsePromise = opt.client({
            url: req.url,
            method: "POST",
            header: req.header,
            body: pipe(
              writable,
              transformNormalizeMessage(method.I),
              transformSerializeEnvelope(
                serialization.getI(opt.useBinaryFormat),
                opt.writeMaxBytes
              ),
              transformCompressEnvelope(
                opt.sendCompression,
                opt.compressMinBytes
              ),
              transformJoinEnvelopes()
            ),
            signal: req.signal,
          });
          const responseTrailer = defer<Headers>();
          let outputIt: AsyncIterator<O> | undefined;
          const conn: StreamingConn<I, O> = {
            ...req,
            responseHeader: universalResponsePromise.then((r) => r.header),
            responseTrailer: responseTrailer,
            closed: false,
            async send(message: PartialMessage<I>): Promise<void> {
              await writable.write(message);
            },
            async close(): Promise<void> {
              await writable.close();
            },
            async read(): Promise<ReadableStreamReadResultLike<O>> {
              if (outputIt === undefined) {
                const uRes = await universalResponsePromise;
                const { compression, foundStatus } =
                  validateResponseWithCompression(
                    opt.useBinaryFormat,
                    opt.acceptCompression,
                    uRes.status,
                    uRes.header
                  );
                outputIt = pipe(
                  uRes.body,
                  transformSplitEnvelope(opt.readMaxBytes),
                  transformDecompressEnvelope(
                    compression ?? null,
                    opt.readMaxBytes
                  ),
                  transformParseEnvelope(
                    serialization.getO(opt.useBinaryFormat),
                    trailerFlag,
                    createTrailerSerialization()
                  ),
                  async function* (iterable) {
                    if (foundStatus) {
                      // A grpc-status: 0 response header was present. This is a "trailers-only"
                      // response (a response without a body and no trailers).
                      //
                      // The spec seems to disallow a trailers-only response for status 0 - we are
                      // lenient and only verify that the body is empty.
                      //
                      // > [...] Trailers-Only is permitted for calls that produce an immediate error.
                      // See https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md
                      const r = await iterable[Symbol.asyncIterator]().next();
                      if (r.done !== true) {
                        const e = new ConnectError(
                          "protocol error: received extra trailer",
                          Code.InvalidArgument
                        );
                        responseTrailer.reject(e);
                        throw e;
                      }
                      return;
                    }
                    let trailerReceived = false;
                    for await (const chunk of iterable) {
                      if (chunk.end) {
                        if (trailerReceived) {
                          const e = new ConnectError(
                            "protocol error: received extra trailer",
                            Code.InvalidArgument
                          );
                          responseTrailer.reject(e);
                          throw e;
                        }
                        trailerReceived = true;
                        validateTrailer(chunk.value);
                        responseTrailer.resolve(chunk.value);
                        continue;
                      }
                      if (trailerReceived) {
                        const e = new ConnectError(
                          "protocol error: received extra message after trailer",
                          Code.InvalidArgument
                        );
                        responseTrailer.reject(e);
                        throw e;
                      }
                      yield chunk.value;
                    }
                    if (!trailerReceived) {
                      const e = new ConnectError(
                        "protocol error: missing trailer",
                        Code.InvalidArgument
                      );
                      responseTrailer.reject(e);
                      throw e;
                    }
                  }
                )[Symbol.asyncIterator]();
              }
              const r = await outputIt.next();
              if (r.done === true) {
                return { done: true, value: undefined };
              }
              return { done: false, value: r.value };
            },
          };
          return conn;
        },
        options.interceptors
      );
    },
  };
}
