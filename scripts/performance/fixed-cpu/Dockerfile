# Fixed patch versions; runner additionally records resolved IDs/digests. No latest.
FROM golang:1.24.4-bookworm AS tools
WORKDIR /build
COPY scripts/performance/fixed-cpu/client.go scripts/performance/fixed-cpu/client_test.go scripts/performance/fixed-cpu/mock.go scripts/performance/fixed-cpu/mock_test.go ./
RUN CGO_ENABLED=0 go test client.go client_test.go \
 && CGO_ENABLED=0 go test mock.go mock_test.go \
 && CGO_ENABLED=0 go build -trimpath -ldflags='-buildid=' -o /quota-client client.go \
 && CGO_ENABLED=0 go build -trimpath -ldflags='-buildid=' -o /quota-mock mock.go
FROM node:22.16.0-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY deploy ./deploy
COPY tests/saas/gateway/fast/native-http-seed-fixture.ts tests/saas/gateway/fast/native-http-runtime-fixture.ts ./tests/saas/gateway/fast/
COPY scripts/performance/fixed-cpu ./scripts/performance/fixed-cpu
RUN npm run build:server && node scripts/performance/fixed-cpu/compile-fixtures.cjs
COPY --from=tools /quota-client /quota-mock /usr/local/bin/
# No ENTRYPOINT wrapper: primary is PID 1, all app descendants stay in its cgroup.
CMD ["node", "dist/cli/index.js", "start", "--role", "gateway"]
