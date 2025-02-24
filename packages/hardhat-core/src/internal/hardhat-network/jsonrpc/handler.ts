import { IncomingMessage, ServerResponse } from "http";
import getRawBody from "raw-body";
import WebSocket from "ws";

import { EIP1193Provider } from "../../../types";
import {
  InternalError,
  InvalidJsonInputError,
  InvalidRequestError,
  ProviderError,
} from "../../core/providers/errors";
import {
  FailedJsonRpcResponse,
  isSuccessfulJsonResponse,
  isValidJsonRequest,
  isValidJsonResponse,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../util/jsonrpc";

/* eslint-disable @nomiclabs/only-hardhat-error */

export default class JsonRpcHandler {
  constructor(private readonly _provider: EIP1193Provider) {}

  public handleHttp = async (req: IncomingMessage, res: ServerResponse) => {
    this._setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      this._sendEmptyResponse(res);
      return;
    }

    let jsonHttpRequest: any;
    try {
      jsonHttpRequest = await _readJsonHttpRequest(req);
    } catch (error) {
      this._sendResponse(res, _handleError(error));
      return;
    }

    if (Array.isArray(jsonHttpRequest)) {
      const responses = await Promise.all(
        jsonHttpRequest.map((singleReq: any) =>
          this._handleSingleRequest(singleReq)
        )
      );

      this._sendResponse(res, responses);
      return;
    }

    const rpcResp = await this._handleSingleRequest(jsonHttpRequest);

    this._sendResponse(res, rpcResp);
  };

  public handleWs = async (ws: WebSocket) => {
    const subscriptions: string[] = [];
    let isClosed = false;

    const listener = (payload: { subscription: string; result: any }) => {
      // Don't attempt to send a message to the websocket if we already know it is closed,
      // or the current websocket connection isn't interested in the particular subscription.
      if (isClosed || !subscriptions.includes(payload.subscription)) {
        return;
      }

      try {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_subscription",
            params: payload,
          })
        );
      } catch (error) {
        _handleError(error);
      }
    };

    // Handle eth_subscribe notifications.
    this._provider.addListener("notification", listener);

    ws.on("message", async (msg) => {
      let rpcReq: JsonRpcRequest | undefined;
      let rpcResp: JsonRpcResponse | undefined;

      try {
        rpcReq = _readWsRequest(msg as string);

        if (!isValidJsonRequest(rpcReq)) {
          throw new InvalidRequestError("Invalid request");
        }

        rpcResp = await this._handleRequest(rpcReq);

        // If eth_subscribe was successful, keep track of the subscription id,
        // so we can cleanup on websocket close.
        if (
          rpcReq.method === "eth_subscribe" &&
          isSuccessfulJsonResponse(rpcResp)
        ) {
          subscriptions.push(rpcResp.result);
        }
      } catch (error) {
        rpcResp = _handleError(error);
      }

      // Validate the RPC response.
      if (!isValidJsonResponse(rpcResp)) {
        // Malformed response coming from the provider, report to user as an internal error.
        rpcResp = _handleError(new InternalError("Internal error"));
      }

      if (rpcReq !== undefined) {
        rpcResp.id = rpcReq.id;
      }

      ws.send(JSON.stringify(rpcResp));
    });

    ws.on("close", () => {
      // Remove eth_subscribe listener.
      this._provider.removeListener("notification", listener);

      // Clear any active subscriptions for the closed websocket connection.
      isClosed = true;
      subscriptions.forEach(async (subscriptionId) => {
        await this._provider.request({
          method: "eth_unsubscribe",
          params: [subscriptionId],
        });
      });
    });
  };

  private _sendEmptyResponse(res: ServerResponse) {
    res.writeHead(200);
    res.end();
  }

  private _setCorsHeaders(res: ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Request-Method", "*");
    res.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET");
    res.setHeader("Access-Control-Allow-Headers", "*");
  }

  private _sendResponse(
    res: ServerResponse,
    rpcResp: JsonRpcResponse | JsonRpcResponse[]
  ) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(rpcResp));
  }

  private async _handleSingleRequest(req: any): Promise<JsonRpcResponse> {
    if (!isValidJsonRequest(req)) {
      return _handleError(new InvalidRequestError("Invalid request"));
    }

    const rpcReq: JsonRpcRequest = req;
    let rpcResp: JsonRpcResponse | undefined;

    try {
      rpcResp = await this._handleRequest(rpcReq);
    } catch (error) {
      rpcResp = _handleError(error);
    }

    // Validate the RPC response.
    if (!isValidJsonResponse(rpcResp)) {
      // Malformed response coming from the provider, report to user as an internal error.
      rpcResp = _handleError(new InternalError("Internal error"));
    }

    if (rpcReq !== undefined) {
      rpcResp.id = rpcReq.id !== undefined ? rpcReq.id : null;
    }

    return rpcResp;
  }

  private _handleRequest = async (
    req: JsonRpcRequest
  ): Promise<JsonRpcResponse> => {
    const result = await this._provider.request({
      method: req.method,
      params: req.params,
    });

    return {
      jsonrpc: "2.0",
      id: req.id,
      result,
    };
  };
}

const _readJsonHttpRequest = async (req: IncomingMessage): Promise<any> => {
  let json;

  try {
    const buf = await getRawBody(req);
    const text = buf.toString();

    json = JSON.parse(text);
  } catch (error) {
    throw new InvalidJsonInputError(`Parse error: ${error.message}`);
  }

  return json;
};

const _readWsRequest = (msg: string): JsonRpcRequest => {
  let json: any;
  try {
    json = JSON.parse(msg);
  } catch (error) {
    throw new InvalidJsonInputError(`Parse error: ${error.message}`);
  }

  return json;
};

const _handleError = (error: any): JsonRpcResponse => {
  let txHash: string | undefined;
  if (error.transactionHash !== undefined) {
    txHash = error.transactionHash;
  }

  // In case of non-hardhat error, treat it as internal and associate the appropriate error code.
  if (!ProviderError.isProviderError(error)) {
    error = new InternalError(error);
  }

  const response: FailedJsonRpcResponse = {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: error.code,
      message: error.message,
    },
  };

  if (txHash !== undefined) {
    response.error.data = {
      txHash,
    };
  }

  return response;
};
