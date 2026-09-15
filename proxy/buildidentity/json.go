package buildidentity

import (
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"
)

// Token parsing detects duplicates before encoding/json can overwrite them.
// Go repairs lone surrogate escapes to U+FFFD. Requiring ASCII after decoding
// rejects that repair, as well as every non-ASCII scalar, before serialization.
func parse(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, invalid()
	}
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			object := map[string]any{}
			for dec.More() {
				keyToken, err := dec.Token()
				if err != nil {
					return nil, invalid()
				}
				key, ok := keyToken.(string)
				if !ok || !ascii(key) {
					return nil, invalid()
				}
				if _, exists := object[key]; exists {
					return nil, invalid()
				}
				item, err := parse(dec)
				if err != nil {
					return nil, err
				}
				object[key] = item
			}
			end, err := dec.Token()
			if err != nil || end != json.Delim('}') {
				return nil, invalid()
			}
			return object, nil
		case '[':
			array := []any{}
			for dec.More() {
				item, err := parse(dec)
				if err != nil {
					return nil, err
				}
				array = append(array, item)
			}
			end, err := dec.Token()
			if err != nil || end != json.Delim(']') {
				return nil, invalid()
			}
			return array, nil
		}
		return nil, invalid()
	case string:
		if !ascii(value) {
			return nil, invalid()
		}
		return value, nil
	case json.Number:
		// The only number in the closed schema is schemaVersion = 1. Test
		// exact decimal equality without floating-point rounding or expanding
		// attacker-controlled exponents into enormous powers of ten.
		if !exactlyOne(string(value)) {
			return nil, invalid()
		}
		return int64(1), nil
	default:
		return value, nil
	}
}

func exactlyOne(number string) bool {
	if strings.HasPrefix(number, "-") {
		return false
	}
	parts := strings.FieldsFunc(number, func(c rune) bool { return c == 'e' || c == 'E' })
	exponent := new(big.Int)
	if len(parts) == 2 {
		if _, ok := exponent.SetString(parts[1], 10); !ok {
			return false
		}
	}
	mantissa := parts[0]
	if point := strings.IndexByte(mantissa, '.'); point >= 0 {
		exponent.Sub(exponent, big.NewInt(int64(len(mantissa)-point-1)))
		mantissa = strings.ReplaceAll(mantissa, ".", "")
	}
	mantissa = strings.TrimLeft(mantissa, "0")
	significant := strings.TrimRight(mantissa, "0")
	exponent.Add(exponent, big.NewInt(int64(len(mantissa)-len(significant))))
	return significant == "1" && exponent.Sign() == 0
}

func ascii(s string) bool {
	for _, c := range s {
		if c > 127 {
			return false
		}
	}
	return true
}

// This validated domain contains only ASCII strings, integers, empty arrays,
// and objects. ASCII key order equals JCS UTF-16 order. Use ECMAScript escapes,
// not encoding/json's HTML escaping, and emit no trailing newline.
func quote(s string) string {
	var output strings.Builder
	output.WriteByte('"')
	for _, c := range []byte(s) {
		switch c {
		case '"', '\\':
			output.WriteByte('\\')
			output.WriteByte(c)
		case 8:
			output.WriteString(`\b`)
		case 9:
			output.WriteString(`\t`)
		case 10:
			output.WriteString(`\n`)
		case 12:
			output.WriteString(`\f`)
		case 13:
			output.WriteString(`\r`)
		default:
			if c < 32 {
				fmt.Fprintf(&output, `\u%04x`, c)
			} else {
				output.WriteByte(c)
			}
		}
	}
	output.WriteByte('"')
	return output.String()
}

func canonical(value any) string {
	switch value := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, quote(key)+":"+canonical(value[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			parts = append(parts, canonical(item))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case string:
		return quote(value)
	case int64:
		return strconv.FormatInt(value, 10)
	default:
		panic("unvalidated canonical input")
	}
}
