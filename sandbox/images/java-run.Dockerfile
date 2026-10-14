# syntax=docker/dockerfile:1
# Build context: runner/  (see scripts/build-images.ps1)

# --- judge-exec: built with the same toolchain runner/go.mod pins (go1.27.2) ---
FROM golang:1.27.2@sha256:5bc7f572bbaa98885a3a1fd9c0aa76b59e3e14e8628bfc316bbfd0c701e4818c AS judge-exec
WORKDIR /src
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=local
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build go build -trimpath -ldflags="-s -w" -o /out/judge-exec ./cmd/judge-exec

# --- Java run image: Eclipse Temurin 21 JRE only (no javac) + judge-exec ---
FROM eclipse-temurin:21.0.12_8-jre-noble@sha256:7739f0ffce786528961eea6bf46d9610ee968ac6127c9b2e93494757bdecce9f
COPY --from=judge-exec /out/judge-exec /judge-exec
LABEL judge.managed=true
WORKDIR /box
USER 65534:65534
ENTRYPOINT ["/judge-exec"]
