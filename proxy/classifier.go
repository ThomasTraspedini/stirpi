package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"sort"
	"strings"
)

// This immutable, reviewed table is the D068 stirpi.public-address/1 input.
// Each line is CIDR|Global. Updating IANA data means a new policy/image, never
// consulting host networking databases at runtime.
const specialPurposeTable = `0.0.0.0/8|false
10.0.0.0/8|false
100.64.0.0/10|false
127.0.0.0/8|false
169.254.0.0/16|false
172.16.0.0/12|false
192.0.0.0/24|false
192.0.0.9/32|true
192.0.0.10/32|true
192.0.2.0/24|false
192.31.196.0/24|true
192.52.193.0/24|true
192.88.99.0/24|false
192.168.0.0/16|false
192.175.48.0/24|true
198.18.0.0/15|false
198.51.100.0/24|false
203.0.113.0/24|false
224.0.0.0/4|false
240.0.0.0/4|false
::/128|false
::1/128|false
::ffff:0:0/96|false
64:ff9b::/96|true
64:ff9b:1::/48|false
100::/64|false
2001::/23|false
2001:1::1/128|true
2001:1::2/128|true
2001:2::/48|false
2001:db8::/32|false
2002::/16|true
3fff::/20|false
fc00::/7|false
fe80::/10|false
fec0::/10|false
ff00::/8|false`

type specialRange struct {
	network *net.IPNet
	global  bool
}

var classifierRanges = parseClassifierTable()

func parseClassifierTable() []specialRange {
	var out []specialRange
	for _, line := range strings.Split(specialPurposeTable, "\n") {
		parts := strings.Split(line, "|")
		if len(parts) != 2 {
			panic("invalid embedded classifier table")
		}
		_, network, err := net.ParseCIDR(parts[0])
		if err != nil {
			panic("invalid embedded classifier table")
		}
		out = append(out, specialRange{network, parts[1] == "true"})
	}
	return out
}
func classifierTableDigest() string {
	h := sha256.Sum256([]byte(specialPurposeTable))
	return "sha256:" + hex.EncodeToString(h[:])
}
func publicAddress(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	matched := false
	global := false
	bestBits := -1
	for _, entry := range classifierRanges {
		// Classify mapped addresses as IPv4, without matching IPv6 table
		// prefixes against Go's implicit IPv4-mapped representation.
		_, bits := entry.network.Mask.Size()
		if (ip.To4() != nil) != (bits == 32) {
			continue
		}
		if entry.network.Contains(ip) {
			ones, _ := entry.network.Mask.Size()
			if ones > bestBits {
				matched, global, bestBits = true, entry.global, ones
			}
		}
	}
	if matched {
		return global
	}
	return !ip.IsMulticast() && !ip.IsUnspecified()
}
func normalizeIP(ip net.IP) net.IP {
	if v4 := ip.To4(); v4 != nil {
		return append(net.IP(nil), v4...)
	}
	return append(net.IP(nil), ip.To16()...)
}
func validateResolved(input []net.IP) ([]net.IP, error) {
	seen := map[string]net.IP{}
	for _, raw := range input {
		ip := normalizeIP(raw)
		if ip == nil || !publicAddress(ip) {
			return nil, errProhibited
		}
		seen[string(ip.To16())] = ip
	}
	if len(seen) == 0 {
		return nil, errDNS
	}
	out := make([]net.IP, 0, len(seen))
	for _, ip := range seen {
		out = append(out, ip)
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i]) != len(out[j]) {
			return len(out[i]) < len(out[j])
		}
		return strings.Compare(string(out[i]), string(out[j])) < 0
	})
	return out, nil
}
