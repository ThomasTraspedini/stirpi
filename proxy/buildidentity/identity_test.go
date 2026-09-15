package buildidentity

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "test", "fixtures", "build-identity-v1", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestGolden(t *testing.T) {
	var vectors []struct {
		Fixture        int
		CanonicalBytes int
		PreimageBytes  int
		BuildIdentity  string
	}
	if err := json.Unmarshal(fixture(t, "golden.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		t.Run(fmt.Sprint(vector.Fixture), func(t *testing.T) {
			result, err := Derive(fixture(t, fmt.Sprintf("golden-%d.json", vector.Fixture)))
			if err != nil {
				t.Fatal(err)
			}
			if result.Identity != vector.BuildIdentity || len(result.Canonical) != vector.CanonicalBytes || len(result.Preimage) != vector.PreimageBytes || len(Domain) != 47 {
				t.Fatal("golden identity/length mismatch")
			}
			if !bytes.Equal(result.Canonical, fixture(t, fmt.Sprintf("golden-%d.jcs", vector.Fixture))) || !bytes.Equal(result.Preimage, fixture(t, fmt.Sprintf("golden-%d.preimage", vector.Fixture))) {
				t.Fatal("golden byte mismatch")
			}
			hash := sha256.Sum256(result.Preimage)
			if "sha256:"+hex.EncodeToString(hash[:]) != vector.BuildIdentity {
				t.Fatal("ordinary SHA256 mismatch")
			}
			again, err := Derive(append(result.Canonical, '\n'))
			if err != nil || !bytes.Equal(again.Preimage, result.Preimage) {
				t.Fatal("member order/whitespace changed identity")
			}
		})
	}
}

func TestNegativeMatrix(t *testing.T) {
	var cases []struct {
		Name   string
		Hex    string
		Path   []string
		Value  any
		Remove bool
	}
	if err := json.Unmarshal(fixture(t, "negative.json"), &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var input []byte
			var err error
			if c.Hex != "" {
				input, err = hex.DecodeString(c.Hex)
				if err != nil {
					t.Fatal(err)
				}
			} else {
				var document map[string]any
				if err = json.Unmarshal(fixture(t, "golden-1.json"), &document); err != nil {
					t.Fatal(err)
				}
				node := document
				for _, key := range c.Path[:len(c.Path)-1] {
					node = node[key].(map[string]any)
				}
				key := c.Path[len(c.Path)-1]
				if c.Remove {
					delete(node, key)
				} else {
					node[key] = c.Value
				}
				input, err = json.Marshal(document)
				if err != nil {
					t.Fatal(err)
				}
			}
			if _, err = Derive(input); err == nil {
				t.Fatal("accepted invalid authority")
			}
		})
	}
}

func TestMutations(t *testing.T) {
	original := fixture(t, "golden-1.json")
	baseline, err := Derive(original)
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{
		{"https://github.com/example/stirpi", "https://github.com/example/other"},
		{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		{"sha256:bbbb", "sha256:0bbb"},
		{"ghcr.io/stirpi/proxy-builder", "ghcr.io/stirpi/other-builder"},
		{"sha256:cccc", "sha256:0ccc"},
		{"arm64", "amd64"},
	} {
		changed := bytes.ReplaceAll(original, []byte(pair[0]), []byte(pair[1]))
		result, err := Derive(changed)
		if err != nil || result.Identity == baseline.Identity {
			t.Fatalf("mutation failed: %v %v", pair, err)
		}
	}
}

func TestEquivalentNumbers(t *testing.T) {
	original := fixture(t, "golden-1.json")
	baseline, err := Derive(original)
	if err != nil {
		t.Fatal(err)
	}
	for _, spelling := range []string{"1.0", "1e0", "1e+0", "10e-1", "0.01e2"} {
		input := bytes.Replace(original, []byte(`"schemaVersion": 1`), []byte(`"schemaVersion": `+spelling), 1)
		result, err := Derive(input)
		if err != nil || !bytes.Equal(result.Preimage, baseline.Preimage) {
			t.Fatalf("integer spelling changed identity: %s %v", spelling, err)
		}
	}
}
