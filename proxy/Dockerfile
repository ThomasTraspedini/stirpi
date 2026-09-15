# The release command requires BUILDER_IMAGE to be an OCI digest reference and
# derives BUILD_IDENTITY from exact pre-build authority before Docker sees this file. There is deliberately no default:
# a source checkout cannot silently select a mutable builder.
ARG BUILDER_IMAGE
FROM ${BUILDER_IMAGE} AS build
ARG BUILD_IDENTITY
WORKDIR /src/proxy
COPY proxy/go.mod proxy/main.go proxy/classifier.go proxy/dns.go ./
RUN --network=none test -n "$BUILD_IDENTITY" && \
    printf '%s' "$BUILD_IDENTITY" | grep -Eq '^sha256:[0-9a-f]{64}$' && \
    GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off CGO_ENABLED=0 GOOS=linux go build -trimpath -buildvcs=false \
      -ldflags="-w -X main.buildIdentity=${BUILD_IDENTITY}" \
      -o /out/stirpi-registry-egress-proxy .

FROM scratch AS final
COPY --from=build /out/stirpi-registry-egress-proxy /stirpi-registry-egress-proxy
WORKDIR /
USER 65532:65532
ENTRYPOINT ["/stirpi-registry-egress-proxy"]
CMD []
STOPSIGNAL SIGTERM
