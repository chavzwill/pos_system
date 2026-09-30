function required(value, code) {
  if (!value) throw new Error(code);
  return value;
}

export class HttpReadAdapter {
  constructor({ baseUrl, token, source, fetchImpl = globalThis.fetch }) {
    this.baseUrl = required(baseUrl?.replace(/\/$/, ""), "ADAPTER_BASE_URL_REQUIRED");
    this.token = required(token, "ADAPTER_SERVER_TOKEN_REQUIRED");
    this.source = required(source, "ADAPTER_SOURCE_REQUIRED");
    this.fetch = required(fetchImpl, "ADAPTER_FETCH_REQUIRED");
  }

  async get(path, { signal } = {}) {
    if (!path.startsWith("/")) throw new Error("ADAPTER_PATH_INVALID");
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        "x-tt-ai-source": "tt-ai",
      },
    });
    if (!response.ok) {
      const error = new Error(`UPSTREAM_READ_FAILED:${this.source}:${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
}
