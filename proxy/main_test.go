package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClassifierRejectsSpecialAndMappedIPv4(t *testing.T) {
	for _, value := range []string{"10.0.0.1", "100.64.0.1", "127.0.0.1", "192.0.2.1", "::1", "fc00::1", "::ffff:192.0.2.1"} {
		if publicAddress(net.ParseIP(value)) {
			t.Fatalf("%s unexpectedly public", value)
		}
	}
	for _, value := range []string{"8.8.8.8", "::ffff:8.8.8.8", "2001:4860:4860::8888", "192.0.0.9"} {
		if !publicAddress(net.ParseIP(value)) {
			t.Fatalf("%s ordinary unicast or explicit global exception rejected", value)
		}
	}
	if !strings.HasPrefix(classifierTableDigest(), "sha256:") || classifierTableDigest() != classifierTableDigest() {
		t.Fatal("classifier identity is not deterministic")
	}
}

func TestPrivateIPv4LaunchAddresses(t *testing.T) {
	for _, value := range []string{"10.0.0.2", "172.16.0.2", "172.30.0.3", "172.31.0.2", "192.168.0.2"} {
		if !privateIPv4(value) {
			t.Errorf("canonical private launch address rejected: %s", value)
		}
	}
	for _, value := range []string{"", "8.8.8.8", "127.0.0.1", "172.15.0.2", "172.32.0.2", "::ffff:10.0.0.2", "10.00.0.2", "fc00::2"} {
		if privateIPv4(value) {
			t.Errorf("invalid launch address accepted: %s", value)
		}
	}
}

func TestConnectHeaderValidation(t *testing.T) {
	const host = "Host: registry.npmjs.org:443\r\n"
	for _, tc := range []struct {
		name     string
		headers  string
		accepted bool
	}{
		{"valid CRLF", host, true},
		{"64 fields", host + strings.Repeat("X-Test: ok\r\n", 63), true},
		{"65 fields", host + strings.Repeat("X-Test: ok\r\n", 64), false},
		{"bare LF", "Host: registry.npmjs.org:443\n", false},
		{"embedded CR", host + "X-Test: a\rb\r\n", false},
		{"embedded NUL", host + "X-Test: a\x00b\r\n", false},
		{"duplicate Host", host + host, false},
		{"missing Host", "X-Test: ok\r\n", false},
		{"mismatched Host", "Host: other.example:443\r\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resolver := &countingResolver{addresses: []net.IP{net.ParseIP("8.8.8.8")}}
			dialer := &recordingDialer{}
			proxy, client := net.Pipe()
			defer client.Close()
			p := policy{Policy: policyBody{Allowed: []destination{{Host: "registry.npmjs.org", Port: 443}}}}
			done := make(chan struct{})
			go func() { handle(proxy, p, resolver, dialer); close(done) }()
			_ = client.SetDeadline(time.Now().Add(time.Second))
			if _, err := client.Write([]byte("CONNECT registry.npmjs.org:443 HTTP/1.1\r\n" + tc.headers + "\r\n")); err != nil {
				t.Fatal(err)
			}
			buffer := make([]byte, 256)
			n, err := client.Read(buffer)
			if err != nil {
				t.Fatal(err)
			}
			_ = client.Close()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("proxy did not finish")
			}
			status, calls := "400 Bad Request", int32(0)
			if tc.accepted {
				status, calls = "200 Connection Established", 1
			}
			if !strings.HasPrefix(string(buffer[:n]), "HTTP/1.1 "+status+"\r\n") || resolver.calls.Load() != calls || dialer.calls.Load() != calls {
				t.Fatalf("response %q, DNS calls %d, dial calls %d", buffer[:n], resolver.calls.Load(), dialer.calls.Load())
			}
		})
	}
}

func TestResolverSnapshotIsExplicitAndSorted(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "resolv.conf")
	if err := os.WriteFile(path, []byte("search ignored.example\nnameserver 2001:4860:4860::8888\nnameserver 8.8.8.8\nnameserver 8.8.8.8\n"), 0600); err != nil {
		t.Fatal(err)
	}
	endpoints, err := snapshotResolvers(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(endpoints) != 2 || endpoints[0].Address != "2001:4860:4860::8888" || endpoints[1].Address != "8.8.8.8" {
		t.Fatalf("unexpected snapshot: %#v", endpoints)
	}
}

type countingResolver struct {
	calls     atomic.Int32
	addresses []net.IP
}

func (r *countingResolver) Resolve(context.Context, string) ([]net.IP, error) {
	r.calls.Add(1)
	return r.addresses, nil
}

type recordingDialer struct {
	calls     atomic.Int32
	addresses []net.IP
}

func (d *recordingDialer) Dial(_ context.Context, ip net.IP, _ int) (net.Conn, error) {
	d.calls.Add(1)
	d.addresses = append(d.addresses, append(net.IP(nil), ip...))
	left, right := net.Pipe()
	go right.Close()
	return left, nil
}

func TestConnectResolvesOnceThenDialsOnlySavedNumericAddress(t *testing.T) {
	resolver := &countingResolver{addresses: []net.IP{net.ParseIP("8.8.8.8")}}
	dialer := &recordingDialer{}
	proxy, client := net.Pipe()
	defer client.Close()
	p := policy{Policy: policyBody{Allowed: []destination{{Host: "registry.npmjs.org", Port: 443}}}}
	done := make(chan struct{})
	go func() { handle(proxy, p, resolver, dialer); close(done) }()
	if _, err := client.Write([]byte("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 128)
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	n, err := client.Read(buffer)
	if err != nil || !strings.Contains(string(buffer[:n]), "200 Connection Established") {
		t.Fatalf("CONNECT failed: %v %q", err, buffer[:n])
	}
	_ = client.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("proxy did not finish")
	}
	if resolver.calls.Load() != 1 || dialer.calls.Load() != 1 || len(dialer.addresses) != 1 || !dialer.addresses[0].Equal(net.ParseIP("8.8.8.8")) {
		t.Fatal("resolver/dial boundary was not resolve-once numeric dialing")
	}
}

func TestMixedAnswerFailsClosed(t *testing.T) {
	_, err := validateResolved([]net.IP{net.ParseIP("8.8.8.8"), net.ParseIP("10.0.0.1")})
	if !errors.Is(err, errProhibited) {
		t.Fatalf("wanted prohibited-address rejection, got %v", err)
	}
}
