// Offline independent D072 identity derivation; no proxy execution or network.
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"stirpi-registry-egress-proxy/buildidentity"
)

func main() {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 1024*1024+1))
	if err != nil || len(input) > 1024*1024 {
		fmt.Fprintln(os.Stderr, "invalid identity input")
		os.Exit(1)
	}
	result, err := buildidentity.Derive(input)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	err = json.NewEncoder(os.Stdout).Encode(map[string]string{
		"canonicalHex":  hex.EncodeToString(result.Canonical),
		"preimageHex":   hex.EncodeToString(result.Preimage),
		"buildIdentity": result.Identity,
	})
	if err != nil {
		os.Exit(1)
	}
}
