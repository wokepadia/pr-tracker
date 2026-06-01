import { describe, expect, it } from "vitest";
import { getApiConfig } from "./config";

describe("api config", () => {
  it("uses local defaults", () => {
    expect(getApiConfig({})).toEqual({
      API_HOST: "127.0.0.1",
      API_PORT: 4000,
      WEB_ORIGIN: "http://127.0.0.1:5173"
    });
  });

  it("coerces API_PORT from environment strings", () => {
    expect(
      getApiConfig({
        API_PORT: "4100",
        API_HOST: "0.0.0.0",
        WEB_ORIGIN: "https://reviews.example.com"
      })
    ).toEqual({
      API_HOST: "0.0.0.0",
      API_PORT: 4100,
      WEB_ORIGIN: "https://reviews.example.com"
    });
  });
});
