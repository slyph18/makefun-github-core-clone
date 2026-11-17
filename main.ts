import { createApp } from "./app.ts";

const REQUEST_TIMEOUT_MS = 30000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(attempt: number): number {
  return Math.min(RETRY_INITIAL_MS * 2 ** attempt, RETRY_MAX_MS);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function registerWithHarness(
  environmentUrl: string,
  port: number,
): Promise<void> {
  const registerUrl = new URL("/register", environmentUrl);
  let attempt = 0;

  while (true) {
    let response: Response;
    try {
      response = await fetch(registerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await sleep(retryDelay(attempt++));
      continue;
    }

    if (response.status === 200 || response.status === 409) {
      return;
    }

    if (response.status === 400 || response.status === 405) {
      throw new Error(`register failed with HTTP ${response.status}`);
    }

    await sleep(retryDelay(attempt++));
  }
}

async function waitForDone(environmentUrl: string): Promise<void> {
  const doneUrl = new URL("/done", environmentUrl);
  let attempt = 0;

  while (true) {
    let response: Response;
    try {
      response = await fetch(doneUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      await sleep(retryDelay(attempt++));
      continue;
    }

    if (!response.ok) {
      await sleep(retryDelay(attempt++));
      continue;
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      await sleep(retryDelay(attempt++));
      continue;
    }

    if (
      result !== null &&
      typeof result === "object" &&
      "done" in result &&
      (result as { done?: unknown }).done === true
    ) {
      return;
    }

    await sleep(retryDelay(attempt++));
  }
}

async function main(): Promise<void> {
  const environmentUrl = process.env.MAKEFUN_ENV_URL;
  if (!environmentUrl) {
    throw new Error(
      "MAKEFUN_ENV_URL is not set: there is no env to register with",
    );
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not report a TCP port");
  }

  try {
    await registerWithHarness(environmentUrl, address.port);
    await waitForDone(environmentUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log("[entry] done");
}

main().catch((error: unknown) => {
  console.error(`[entry] ${errorText(error)}`);
  process.exit(1);
});
