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

# --- Go compile image: Go 1.27.2, standard library only, offline + judge-exec ---
# The standard library is compiled once, here, into /opt/gocache with exactly
# the settings submissions are built with (lang.go passes the same GO* values),
# so a submission's build only compiles and links main.go. The cache is
# read-only in the sandbox: each compile copies it to its tmpfs /tmp.
FROM golang:1.27.2@sha256:5bc7f572bbaa98885a3a1fd9c0aa76b59e3e14e8628bfc316bbfd0c701e4818c
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 GOTOOLCHAIN=local GOFLAGS=-trimpath \
    GOPROXY=off GOSUMDB=off GOENV=off GOTELEMETRY=off GOWORK=off
RUN GOCACHE=/opt/gocache GOPATH=/tmp/gopath go build std && \
    GOCACHE=/opt/gocache GOPATH=/tmp/gopath go clean -modcache && \
    chmod -R a+rX,go-w /opt/gocache && rm -rf /tmp/gopath
COPY --from=judge-exec /out/judge-exec /judge-exec
LABEL judge.managed=true
WORKDIR /box
USER 65534:65534
ENTRYPOINT ["/judge-exec"]
