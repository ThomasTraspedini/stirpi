// Package buildidentity implements D072 independently of the Node release code.
// It uses only the Go standard library and never reads mutable build outputs.
package buildidentity

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const Domain = "stirpi.registry-egress-proxy.build-identity.v1\x00"
const Kind = "stirpi.registry-egress-proxy-build-identity/1"

type Result struct {
	Canonical []byte
	Preimage  []byte
	Identity  string
}

var digestRE = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var referenceRE = regexp.MustCompile(`^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$`)
var repositoryRE = regexp.MustCompile(`^https://([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::([1-9][0-9]{0,4}))?/([A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)$`)
var labelRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var hexRE = regexp.MustCompile(`^[0-9a-f]+$`)
var numericLabelRE = regexp.MustCompile(`^(?:[0-9]+|0x[0-9a-f]+)$`)
var contracts = map[string]string{
	"artifact":       "stirpi.registry-egress-proxy-artifact/1",
	"protocol":       "stirpi.connect-only/1",
	"policySchema":   "stirpi.registry-egress-policy/1",
	"resolverPolicy": "stirpi.resolve-once/1",
	"addressPolicy":  "stirpi.public-address/1",
}

func invalid() error { return errors.New("invalid BuildIdentityV1 authority") }

func object(value any, keys ...string) (map[string]any, error) {
	m, ok := value.(map[string]any)
	if !ok || len(m) != len(keys) {
		return nil, invalid()
	}
	for _, key := range keys {
		if _, exists := m[key]; !exists {
			return nil, invalid()
		}
	}
	return m, nil
}

func str(value any) string {
	s, _ := value.(string)
	return s
}

func empty(value any) bool {
	array, ok := value.([]any)
	return ok && len(array) == 0
}

func platform(value any) (string, error) {
	p, err := object(value, "os", "architecture")
	if err != nil || p["os"] != "linux" || (p["architecture"] != "amd64" && p["architecture"] != "arm64") {
		return "", invalid()
	}
	return str(p["architecture"]), nil
}

func validate(value any) error {
	d, err := object(value, "schemaVersion", "kind", "source", "buildDefinition", "builderImage", "target", "buildParameters", "materials", "contracts")
	if err != nil || d["schemaVersion"] != int64(1) || d["kind"] != Kind {
		return invalid()
	}
	source, err := object(d["source"], "repository", "commit")
	if err != nil {
		return err
	}
	repository := str(source["repository"])
	m := repositoryRE.FindStringSubmatch(repository)
	if m == nil || len(repository) > 2048 || net.ParseIP(m[1]) != nil {
		return invalid()
	}
	allNumeric := true
	for _, label := range strings.Split(m[1], ".") {
		if !labelRE.MatchString(label) {
			return invalid()
		}
		allNumeric = allNumeric && numericLabelRE.MatchString(label)
	}
	if allNumeric {
		return invalid()
	}
	if m[2] != "" {
		port, _ := strconv.Atoi(m[2])
		if port > 65535 || port == 443 {
			return invalid()
		}
	}
	for _, part := range strings.Split(m[3], "/") {
		if part == "." || part == ".." {
			return invalid()
		}
	}
	oid, err := object(source["commit"], "algorithm", "value")
	if err != nil {
		return err
	}
	length := 0
	switch oid["algorithm"] {
	case "sha1":
		length = 40
	case "sha256":
		length = 64
	default:
		return invalid()
	}
	commit := str(oid["value"])
	if len(commit) != length || !hexRE.MatchString(commit) {
		return invalid()
	}
	definition, err := object(d["buildDefinition"], "path", "sha256")
	if err != nil || definition["path"] != "proxy/build-definition.json" || !digestRE.MatchString(str(definition["sha256"])) {
		return invalid()
	}
	builder, err := object(d["builderImage"], "reference", "manifestDigest", "platform")
	if err != nil {
		return err
	}
	reference, digest := str(builder["reference"]), str(builder["manifestDigest"])
	if !digestRE.MatchString(digest) || !referenceRE.MatchString(reference) || len(reference) > 327 || !strings.HasSuffix(reference, "@"+digest) {
		return invalid()
	}
	builderPlatform, err := platform(builder["platform"])
	if err != nil {
		return err
	}
	target, err := platform(d["target"])
	if err != nil || builderPlatform != target {
		return invalid()
	}
	parameters, err := object(d["buildParameters"], "context", "dockerfile", "targetStage", "additionalBuildArguments")
	if err != nil || parameters["context"] != "." || parameters["dockerfile"] != "proxy/Dockerfile" || parameters["targetStage"] != "final" || !empty(parameters["additionalBuildArguments"]) || !empty(d["materials"]) {
		return invalid()
	}
	c, err := object(d["contracts"], "artifact", "protocol", "policySchema", "resolverPolicy", "addressPolicy")
	if err != nil {
		return err
	}
	for key, expected := range contracts {
		if c[key] != expected {
			return invalid()
		}
	}
	return nil
}

func Derive(input []byte) (Result, error) {
	if !utf8.Valid(input) || bytes.HasPrefix(input, []byte{239, 187, 191}) {
		return Result{}, invalid()
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	value, err := parse(decoder)
	if err != nil {
		return Result{}, err
	}
	if _, err = decoder.Token(); err != io.EOF {
		return Result{}, invalid()
	}
	if err = validate(value); err != nil {
		return Result{}, err
	}
	document := []byte(canonical(value))
	preimage := append([]byte(Domain), document...)
	hash := sha256.Sum256(preimage)
	return Result{Canonical: document, Preimage: preimage, Identity: "sha256:" + hex.EncodeToString(hash[:])}, nil
}
