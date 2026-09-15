package main

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"
)

var errDNS = errors.New("dns resolution failed")
var errProhibited = errors.New("prohibited address")

const maxCNAME = 8

// resolveDNS speaks DNS to the startup snapshot. It never calls net.Resolver
// and every later dial receives only this returned IP snapshot.
func resolveDNS(ctx context.Context, endpoints []resolverEndpoint, host string) ([]net.IP, error) {
	name := host + "."
	all := []net.IP{}
	for _, qtype := range []uint16{1, 28} {
		current := name
		visited := map[string]bool{}
		for links := 0; links <= maxCNAME; links++ {
			if visited[current] {
				return nil, errDNS
			}
			visited[current] = true
			response, err := dnsRequest(ctx, endpoints, current, qtype, false)
			if err != nil {
				return nil, err
			}
			addresses, cname, truncated, err := parseDNSResponse(response, qtype)
			if err != nil {
				return nil, err
			}
			if truncated {
				response, err = dnsRequest(ctx, endpoints, current, qtype, true)
				if err != nil {
					return nil, err
				}
				addresses, cname, _, err = parseDNSResponse(response, qtype)
				if err != nil {
					return nil, err
				}
			}
			if len(addresses) > 0 {
				all = append(all, addresses...)
				break
			}
			if cname == "" {
				break
			}
			current = cname
		}
	}
	if len(all) == 0 {
		return nil, errDNS
	}
	return all, nil
}
func dnsRequest(ctx context.Context, endpoints []resolverEndpoint, name string, qtype uint16, tcp bool) ([]byte, error) {
	query, err := dnsQuery(name, qtype)
	if err != nil {
		return nil, err
	}
	for _, endpoint := range endpoints {
		network := "udp"
		if tcp {
			network = "tcp"
		}
		conn, err := (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(endpoint.Address, strconv.Itoa(endpoint.Port)))
		if err != nil {
			continue
		}
		_ = conn.SetDeadline(dnsDeadline(ctx))
		if tcp {
			query = append([]byte{byte(len(query) >> 8), byte(len(query))}, query...)
		}
		if _, err = conn.Write(query); err == nil {
			if tcp {
				header := make([]byte, 2)
				_, err = ioReadFull(conn, header)
				if err == nil {
					out := make([]byte, int(binary.BigEndian.Uint16(header)))
					_, err = ioReadFull(conn, out)
					_ = conn.Close()
					if err == nil {
						return out, nil
					}
				}
			} else {
				out := make([]byte, 4096)
				n, readErr := conn.Read(out)
				_ = conn.Close()
				if readErr == nil {
					return out[:n], nil
				}
			}
		}
		_ = conn.Close()
	}
	return nil, errDNS
}
func ioReadFull(c net.Conn, p []byte) (int, error) {
	total := 0
	for total < len(p) {
		n, e := c.Read(p[total:])
		total += n
		if e != nil {
			return total, e
		}
	}
	return total, nil
}
func dnsDeadline(ctx context.Context) time.Time {
	if d, ok := ctx.Deadline(); ok {
		return d
	}
	return time.Now().Add(5 * time.Second)
}
func dnsQuery(name string, qtype uint16) ([]byte, error) {
	encoded, err := encodeDNSName(name)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 12)
	binary.BigEndian.PutUint16(out[2:], 0x0100)
	binary.BigEndian.PutUint16(out[4:], 1)
	out = append(out, encoded...)
	return append(out, byte(qtype>>8), byte(qtype), 0, 1), nil
}
func encodeDNSName(name string) ([]byte, error) {
	if !strings.HasSuffix(name, ".") {
		return nil, errDNS
	}
	out := []byte{}
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		if len(label) == 0 || len(label) > 63 {
			return nil, errDNS
		}
		out = append(out, byte(len(label)))
		out = append(out, label...)
	}
	return append(out, 0), nil
}
func parseDNSResponse(b []byte, qtype uint16) ([]net.IP, string, bool, error) {
	if len(b) < 12 || b[2]&0x80 == 0 || b[3]&0x0f != 0 {
		return nil, "", false, errDNS
	}
	truncated := b[2]&2 != 0
	questions, answers := int(binary.BigEndian.Uint16(b[4:6])), int(binary.BigEndian.Uint16(b[6:8]))
	pos := 12
	for i := 0; i < questions; i++ {
		_, n, e := readDNSName(b, pos)
		if e != nil || n+4 > len(b) {
			return nil, "", false, errDNS
		}
		pos = n + 4
	}
	ips := []net.IP{}
	cname := ""
	for i := 0; i < answers; i++ {
		_, n, e := readDNSName(b, pos)
		if e != nil || n+10 > len(b) {
			return nil, "", false, errDNS
		}
		typ := binary.BigEndian.Uint16(b[n : n+2])
		rdlen := int(binary.BigEndian.Uint16(b[n+8 : n+10]))
		start := n + 10
		if start+rdlen > len(b) {
			return nil, "", false, errDNS
		}
		if typ == qtype && ((typ == 1 && rdlen == 4) || (typ == 28 && rdlen == 16)) {
			ips = append(ips, net.IP(append([]byte(nil), b[start:start+rdlen]...)))
		}
		if typ == 5 {
			target, _, e := readDNSName(b, start)
			if e != nil {
				return nil, "", false, errDNS
			}
			cname = target
		}
		pos = start + rdlen
	}
	return ips, cname, truncated, nil
}
func readDNSName(b []byte, pos int) (string, int, error) {
	labels := []string{}
	next := pos
	jumped := false
	for hops := 0; hops <= 32; hops++ {
		if pos >= len(b) {
			return "", 0, errDNS
		}
		n := int(b[pos])
		if n == 0 {
			if !jumped {
				next = pos + 1
			}
			return strings.Join(labels, ".") + ".", next, nil
		}
		if n&0xc0 == 0xc0 {
			if pos+1 >= len(b) {
				return "", 0, errDNS
			}
			if !jumped {
				next = pos + 2
			}
			pos = int(binary.BigEndian.Uint16(b[pos:pos+2]) & 0x3fff)
			jumped = true
			continue
		}
		if n&0xc0 != 0 || n > 63 || pos+1+n > len(b) {
			return "", 0, errDNS
		}
		labels = append(labels, string(b[pos+1:pos+1+n]))
		pos += n + 1
		if !jumped {
			next = pos
		}
	}
	return "", 0, errDNS
}
