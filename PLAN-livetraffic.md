# Implementation Plan: Live Traffic Monitoring (PLAN-livetraffic.md)

This plan outlines the implementation for the Live Traffic Monitoring features, utilizing the proxy interception layer and the existing dashboard, as specified in `SPEC-livetraffic.md`.

---

## 🗺️ Implementation Phases

We will execute this in **3 sequential phases**.

### Phase 1: Metric Collection in Proxy
1.  **Traffic Interceptor Updates**:
    Modify `src/proxy/proxy.ts`.
    *   Add logic to parse the target host/URL from incoming requests.
    *   Implement byte counting for both the request body and the response body.
    *   Create a mapping function to categorize hosts into known AI services (e.g., `api.openai.com` -> `OpenAI`, `api.anthropic.com` -> `Anthropic`).
2.  **Event Generation**:
    Modify `src/proxy/proxy.ts` and `src/dashboard/eventBus.ts`.
    *   Define a new event type: `TRAFFIC_METRIC`.
    *   Emit `TRAFFIC_METRIC` events containing `{ timestamp, service, bytesSent, bytesReceived }` after each request completes.

### Phase 2: Data Aggregation & API
1.  **In-Memory Aggregation**:
    Modify `src/dashboard/server.ts`.
    *   Listen for `TRAFFIC_METRIC` events.
    *   Maintain an in-memory rolling buffer of recent traffic data (e.g., the last 60 minutes).
    *   Aggregate metrics (total bytes, bytes per service).
2.  **Dashboard API Endpoints**:
    Modify `src/dashboard/server.ts`.
    *   Add a REST endpoint (e.g., `/api/metrics/traffic`) to serve the aggregated historical data for the dashboard's initial load.
    *   Ensure real-time metrics are pushed over the existing WebSocket connection.

### Phase 3: Dashboard UI
1.  **Live Traffic Components**:
    *   Create a real-time line chart component to display `Bytes/sec` over time.
    *   Create a "Service Utilization" component (e.g., a pie chart or progress bars) showing the breakdown of data by AI provider.
2.  **Testing**:
    *   Run `llm-fw` and connect a local agent.
    *   Trigger several requests to different providers (e.g., OpenAI and a local model).
    *   Verify the dashboard accurately reflects the data throughput and identifies the correct services in real-time.
