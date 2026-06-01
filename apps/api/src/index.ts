import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { getApiConfig } from "./config";

const { API_HOST: host, API_PORT: port } = getApiConfig();

serve(
  {
    fetch: createApp().fetch,
    hostname: host,
    port
  },
  (info) => {
    console.log(`API listening on http://${info.address}:${info.port}`);
  }
);
