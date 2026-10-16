# syntax=docker/dockerfile:1
# Release payload for the host (build context: repo root). Not run as a
# container: deploy.sh copies /opt/codejudge out of it into
# /opt/codejudge/releases/<id>/ on the host, where systemd runs the worker.
#
#   bin/judge-worker, bin/judge-admin       static Go binaries
#   app/sandbox/seccomp, app/problems,      what the worker and judge-admin read
#   app/db/migrations, app/deploy           compose file, units, host scripts
FROM golang:1.27.2@sha256:5bc7f572bbaa98885a3a1fd9c0aa76b59e3e14e8628bfc316bbfd0c701e4818c AS build
WORKDIR /src/runner
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=local
COPY runner/go.mod runner/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY runner/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags="-s -w" -o /out/judge-worker ./cmd/judge-worker && \
    go build -trimpath -ldflags="-s -w" -o /out/judge-admin ./cmd/judge-admin

FROM scratch
COPY --from=build /out/ /opt/codejudge/bin/
COPY sandbox/seccomp/ /opt/codejudge/app/sandbox/seccomp/
COPY problems/ /opt/codejudge/app/problems/
COPY db/ /opt/codejudge/app/db/
COPY deploy/ /opt/codejudge/app/deploy/
