// Stirpi's deliberately small D068 CONNECT-only proxy. It has no flags,
// environment configuration, HTTP forwarding, or TLS handling surface.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	policyPath = "/run/stirpi-egress/policy.json"
	listenPort = 3128
)

// buildIdentity is intentionally empty in source. The release build injects
// the independently derived pre-build BuildIdentityV1 digest with -ldflags; an uninjected binary
// refuses to become ready rather than attesting a made-up identity.
var buildIdentity string

type destination struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}
type policyBody struct {
	AddressPolicy  string        `json:"addressPolicy"`
	Allowed        []destination `json:"allowedDestinations"`
	Protocol       string        `json:"protocol"`
	ResolverPolicy string        `json:"resolverPolicy"`
}
type launch struct {
	AllowedClientAddress string `json:"allowedClientAddress"`
	Challenge            string `json:"challenge"`
	ListenerAddress      string `json:"listenerAddress"`
}
type policy struct {
	Launch launch     `json:"launch"`
	Policy policyBody `json:"policy"`
	Schema string     `json:"policySchema"`
	SHA    string     `json:"policySha256"`
}
type resolverEndpoint struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
}

var clientSlots = make(chan struct{}, 64)

func die(message string) { fmt.Fprintln(os.Stderr, message); os.Exit(1) }
func sha256String(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}
func digestOK(s string) bool {
	if len(s) != 71 || !strings.HasPrefix(s, "sha256:") {
		return false
	}
	_, e := hex.DecodeString(s[7:])
	return e == nil && s == strings.ToLower(s)
}

// canonicalJSON is the small RFC 8785 subset used by D068: objects, arrays,
// ASCII strings and safe integers. The policy schema admits no floats.
func canonicalJSON(v any) ([]byte, error) {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for key := range x {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			value, err := canonicalJSON(x[key])
			if err != nil {
				return nil, err
			}
			q, _ := json.Marshal(key)
			parts = append(parts, string(q)+":"+string(value))
		}
		return []byte("{" + strings.Join(parts, ",") + "}"), nil
	case []any:
		parts := make([]string, len(x))
		for i := range x {
			value, err := canonicalJSON(x[i])
			if err != nil {
				return nil, err
			}
			parts[i] = string(value)
		}
		return []byte("[" + strings.Join(parts, ",") + "]"), nil
	case string, bool, nil, json.Number:
		return json.Marshal(x)
	case int:
		return []byte(strconv.Itoa(x)), nil
	default:
		b, err := json.Marshal(x)
		if err != nil {
			return nil, err
		}
		var decoded any
		decoder := json.NewDecoder(strings.NewReader(string(b)))
		decoder.UseNumber()
		if decoder.Decode(&decoded) != nil {
			return nil, errors.New("canonical type")
		}
		return canonicalJSON(decoded)
	}
}
func decodeNoDuplicate(b []byte, out any) error {
	decoder := json.NewDecoder(strings.NewReader(string(b)))
	decoder.UseNumber()
	var check func() error
	check = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		switch t := token.(type) {
		case json.Delim:
			switch t {
			case '{':
				seen := map[string]bool{}
				for decoder.More() {
					k, err := decoder.Token()
					if err != nil {
						return err
					}
					key, ok := k.(string)
					if !ok || seen[key] {
						return errors.New("duplicate object key")
					}
					seen[key] = true
					if err := check(); err != nil {
						return err
					}
				}
				_, err := decoder.Token()
				return err
			case '[':
				for decoder.More() {
					if err := check(); err != nil {
						return err
					}
				}
				_, err := decoder.Token()
				return err
			}
		}
		return nil
	}
	if err := check(); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("trailing data")
	}
	strict := json.NewDecoder(strings.NewReader(string(b)))
	strict.DisallowUnknownFields()
	if err := strict.Decode(out); err != nil {
		return err
	}
	if strict.More() {
		return errors.New("trailing data")
	}
	return nil
}
func privateIPv4(s string) bool {
	ip := net.ParseIP(s)
	if ip == nil || ip.String() != s {
		return false
	}
	ip = ip.To4()
	return ip != nil && ((ip[0] == 10) || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] == 192 && ip[1] == 168))
}
func validHost(host string) bool {
	if host == "" || len(host) > 253 || host != strings.ToLower(host) || strings.HasSuffix(host, ".") || strings.Contains(host, "xn--") || net.ParseIP(host) != nil {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}
func isLowerHex(s string) bool {
	_, err := hex.DecodeString(s)
	return err == nil && s == strings.ToLower(s)
}
func isAllowed(p policy, host string, port int) bool {
	for _, d := range p.Policy.Allowed {
		if d.Host == host && d.Port == port {
			return true
		}
	}
	return false
}
func parsePolicy() policy {
	fi, err := os.Lstat(policyPath)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode()&os.ModeSymlink != 0 || fi.Size() < 2 || fi.Size() > 32*1024 {
		die("policy file invalid")
	}
	fd, err := syscall.Open(policyPath, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		die("policy file invalid")
	}
	file := os.NewFile(uintptr(fd), policyPath)
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() {
		die("policy file invalid")
	}
	b, err := io.ReadAll(file)
	if err != nil || len(b) < 2 || b[len(b)-1] != '\n' || (len(b) >= 3 && string(b[:3]) == "\xef\xbb\xbf") {
		die("policy bytes invalid")
	}
	var generic any
	decoder := json.NewDecoder(strings.NewReader(string(b[:len(b)-1])))
	decoder.UseNumber()
	if decoder.Decode(&generic) != nil {
		die("policy JSON invalid")
	}
	canonical, err := canonicalJSON(generic)
	if err != nil || string(canonical)+"\n" != string(b) {
		die("policy JSON noncanonical")
	}
	var p policy
	if decodeNoDuplicate(b[:len(b)-1], &p) != nil {
		die("policy JSON invalid")
	}
	if p.Schema != "stirpi.registry-egress-policy/1" || p.Policy.AddressPolicy != "stirpi.public-address/1" || p.Policy.Protocol != "stirpi.connect-only/1" || p.Policy.ResolverPolicy != "stirpi.resolve-once/1" || len(p.Policy.Allowed) < 1 || len(p.Policy.Allowed) > 32 {
		die("policy identity invalid")
	}
	if !privateIPv4(p.Launch.AllowedClientAddress) || !privateIPv4(p.Launch.ListenerAddress) || p.Launch.AllowedClientAddress == p.Launch.ListenerAddress || len(p.Launch.Challenge) != 64 || !isLowerHex(p.Launch.Challenge) {
		die("launch invalid")
	}
	for i, d := range p.Policy.Allowed {
		if d.Port != 443 || !validHost(d.Host) || (i > 0 && (p.Policy.Allowed[i-1].Host > d.Host || (p.Policy.Allowed[i-1].Host == d.Host && p.Policy.Allowed[i-1].Port >= d.Port))) {
			die("destination invalid")
		}
	}
	semantic := map[string]any{"policy": p.Policy, "policySchema": p.Schema}
	semanticBytes, err := canonicalJSON(semantic)
	if err != nil || p.SHA != sha256String(semanticBytes) {
		die("policy digest invalid")
	}
	return p
}

type resolver interface {
	Resolve(context.Context, string) ([]net.IP, error)
}
type numericDialer interface {
	Dial(context.Context, net.IP, int) (net.Conn, error)
}
type snapshotResolver struct{ endpoints []resolverEndpoint }
type socketDialer struct{}

func (socketDialer) Dial(ctx context.Context, ip net.IP, port int) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), strconv.Itoa(port)))
}
func snapshotResolvers(path string) ([]resolverEndpoint, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seen := map[string]resolverEndpoint{}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(strings.SplitN(line, "#", 2)[0])
		if len(fields) != 2 || fields[0] != "nameserver" {
			continue
		}
		ip := net.ParseIP(fields[1])
		if ip == nil || ip.String() != fields[1] {
			continue
		}
		seen[ip.String()] = resolverEndpoint{Address: ip.String(), Port: 53}
	}
	out := make([]resolverEndpoint, 0, len(seen))
	for _, endpoint := range seen {
		out = append(out, endpoint)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Address < out[j].Address })
	if len(out) == 0 {
		return nil, errors.New("no numeric resolver endpoints")
	}
	return out, nil
}
func (r snapshotResolver) Resolve(ctx context.Context, host string) ([]net.IP, error) {
	return resolveDNS(ctx, r.endpoints, host)
}
func handle(c net.Conn, p policy, resolver resolver, dialer numericDialer) {
	defer c.Close()
	select {
	case clientSlots <- struct{}{}:
		defer func() { <-clientSlots }()
	default:
		return
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReader(io.LimitReader(c, 8193))
	request, err := reader.ReadString('\n')
	if err != nil {
		reply(c, "400 Bad Request")
		return
	}
	if len(request) > 8192 || strings.ContainsAny(request, "\x00\t") {
		reply(c, "400 Bad Request")
		return
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimSuffix(request, "\n"), "\r"), " ")
	if len(parts) != 3 || parts[0] != "CONNECT" || parts[2] != "HTTP/1.1" {
		reply(c, "405 Method Not Allowed")
		return
	}
	authority := parts[1]
	if strings.Count(authority, ":") != 1 || strings.ContainsAny(authority, "/@%[]?#\\ \r\n") {
		reply(c, "400 Bad Request")
		return
	}
	split := strings.SplitN(authority, ":", 2)
	if !validHost(split[0]) || split[1] != "443" {
		reply(c, "400 Bad Request")
		return
	}
	if !isAllowed(p, split[0], 443) {
		reply(c, "403 Forbidden")
		return
	}
	hostCount := 0
	headerCount := 0
	headerBytes := len(request)
	for {
		line, e := reader.ReadString('\n')
		if e != nil {
			reply(c, "400 Bad Request")
			return
		}
		headerBytes += len(line)
		if headerBytes > 8192 {
			reply(c, "400 Bad Request")
			return
		}
		if line == "\r\n" {
			break
		}
		headerCount++
		if headerCount > 64 || !strings.HasSuffix(line, "\r\n") {
			reply(c, "400 Bad Request")
			return
		}
		line = strings.TrimSuffix(line, "\r\n")
		if strings.ContainsAny(line, "\x00\r\n") {
			reply(c, "400 Bad Request")
			return
		}
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			reply(c, "400 Bad Request")
			return
		}
		if strings.EqualFold(line[:colon], "Host") {
			hostCount++
			if strings.TrimSpace(line[colon+1:]) != authority {
				reply(c, "400 Bad Request")
				return
			}
		}
	}
	if hostCount != 1 {
		reply(c, "400 Bad Request")
		return
	}
	dnsCtx, cancelDNS := context.WithTimeout(context.Background(), 5*time.Second)
	ips, err := resolver.Resolve(dnsCtx, split[0])
	cancelDNS()
	if err != nil {
		reply(c, "502 Bad Gateway")
		return
	}
	valid, err := validateResolved(ips)
	if err != nil {
		reply(c, "502 Bad Gateway")
		return
	}
	dialCtx, cancelDial := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelDial()
	var upstream net.Conn
	for _, ip := range valid {
		upstream, err = dialer.Dial(dialCtx, ip, 443)
		if err == nil {
			break
		}
	}
	if err != nil {
		reply(c, "504 Gateway Timeout")
		return
	}
	defer upstream.Close()
	c.SetDeadline(time.Time{})
	upstream.SetDeadline(time.Time{})
	fmt.Fprint(c, "HTTP/1.1 200 Connection Established\r\n\r\n")
	relay(c, upstream, reader)
}
func relay(client, upstream net.Conn, buffered *bufio.Reader) {
	var wg sync.WaitGroup
	wg.Add(2)
	copyBounded := func(dst io.Writer, src io.Reader) { defer wg.Done(); _, _ = io.CopyN(dst, src, 2*1024*1024*1024+1) }
	go copyBounded(upstream, buffered)
	go copyBounded(client, upstream)
	wg.Wait()
}
func reply(c net.Conn, status string) {
	fmt.Fprintf(c, "HTTP/1.1 %s\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", status)
}
func main() {
	if len(os.Args) != 1 || !digestOK(buildIdentity) {
		die("argv or build identity invalid")
	}
	if os.Getuid() != 65532 || os.Getgid() != 65532 {
		die("runtime identity invalid")
	}
	p := parsePolicy()
	endpoints, err := snapshotResolvers("/etc/resolv.conf")
	if err != nil {
		die("resolver snapshot invalid")
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort(p.Launch.ListenerAddress, strconv.Itoa(listenPort)))
	if err != nil {
		die("listen failed")
	}
	executable, err := os.Executable()
	if err != nil {
		die("executable identity unavailable")
	}
	binary, err := os.ReadFile(executable)
	if err != nil {
		die("executable identity unavailable")
	}
	record := map[string]any{"addressClassifierTableSha256": classifierTableDigest(), "addressPolicy": p.Policy.AddressPolicy, "artifactContract": "stirpi.registry-egress-proxy-artifact/1", "attestationSchema": "stirpi.registry-egress-readiness/1", "buildIdentity": buildIdentity, "effectivePolicySha256": p.SHA, "event": "ready", "executableSha256": sha256String(binary), "launchChallenge": p.Launch.Challenge, "listener": map[string]any{"address": p.Launch.ListenerAddress, "allowedClientAddress": p.Launch.AllowedClientAddress, "port": listenPort}, "policySchema": p.Schema, "protocol": p.Policy.Protocol, "resolverEndpoints": endpoints, "resolverPolicy": p.Policy.ResolverPolicy, "runtime": map[string]any{"gid": os.Getgid(), "uid": os.Getuid()}}
	ready, err := canonicalJSON(record)
	if err != nil {
		die("readiness serialization failed")
	}
	if _, err = fmt.Printf("%s\n", ready); err != nil {
		die("readiness write failed")
	}
	r := snapshotResolver{endpoints: endpoints}
	for {
		connection, err := listener.Accept()
		if err != nil {
			continue
		}
		host, _, _ := net.SplitHostPort(connection.RemoteAddr().String())
		if host != p.Launch.AllowedClientAddress {
			connection.Close()
			continue
		}
		go handle(connection, p, r, socketDialer{})
	}
}
