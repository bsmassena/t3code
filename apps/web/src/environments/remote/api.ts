import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  DesktopBridge,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

class RemoteEnvironmentAuthHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteEnvironmentAuthHttpError";
    this.status = status;
  }
}

export function isRemoteEnvironmentAuthHttpError(
  error: unknown,
): error is RemoteEnvironmentAuthHttpError {
  return error instanceof RemoteEnvironmentAuthHttpError;
}

function remoteEndpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readRemoteAuthErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text();
  if (!text) {
    return fallbackMessage;
  }

  try {
    const parsed = JSON.parse(text) as { readonly error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Fall back to raw text below.
  }

  return text;
}

async function fetchRemoteJson<T>(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly body?: unknown;
}): Promise<T> {
  const requestUrl = remoteEndpointUrl(input.httpBaseUrl, input.pathname);
  const headers = {
    ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
  };
  let responseBodyText: string;
  let responseOk: boolean;
  let responseStatus: number;
  try {
    const desktopBridge: DesktopBridge | undefined =
      typeof window !== "undefined" ? window.desktopBridge : undefined;
    if (desktopBridge?.requestJsonHttp) {
      const response = await desktopBridge.requestJsonHttp({
        url: requestUrl,
        method: input.method ?? "GET",
        headers,
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
      responseBodyText = response.bodyText;
      responseOk = response.ok;
      responseStatus = response.status;
    } else {
      const response = await fetch(requestUrl, {
        method: input.method ?? "GET",
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      });
      responseBodyText = await response.text();
      responseOk = response.ok;
      responseStatus = response.status;
    }
  } catch (error) {
    throw new Error(
      `Failed to fetch remote auth endpoint ${requestUrl} (${(error as Error).message}).`,
      { cause: error },
    );
  }

  if (!responseOk) {
    throw new RemoteEnvironmentAuthHttpError(
      await readRemoteAuthErrorMessage(
        new Response(responseBodyText, { status: responseStatus }),
        `Remote auth request failed (${responseStatus}).`,
      ),
      responseStatus,
    );
  }

  return JSON.parse(responseBodyText) as T;
}

export async function bootstrapRemoteBearerSession(input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
}): Promise<AuthBearerBootstrapResult> {
  return fetchRemoteJson<AuthBearerBootstrapResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/bootstrap/bearer",
    method: "POST",
    body: {
      credential: input.credential,
    },
  });
}

export async function fetchRemoteSessionState(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthSessionState> {
  return fetchRemoteJson<AuthSessionState>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/session",
    bearerToken: input.bearerToken,
  });
}

export async function fetchRemoteEnvironmentDescriptor(input: {
  readonly httpBaseUrl: string;
}): Promise<ExecutionEnvironmentDescriptor> {
  return fetchRemoteJson<ExecutionEnvironmentDescriptor>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/.well-known/t3/environment",
  });
}

export async function issueRemoteWebSocketToken(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthWebSocketTokenResult> {
  return fetchRemoteJson<AuthWebSocketTokenResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/ws-token",
    method: "POST",
    bearerToken: input.bearerToken,
  });
}

export async function resolveRemoteWebSocketConnectionUrl(input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<string> {
  const issued = await issueRemoteWebSocketToken({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
  });
  const url = new URL(input.wsBaseUrl, window.location.origin);
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}
