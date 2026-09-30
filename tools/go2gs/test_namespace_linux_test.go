// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
)

var executableNamespaceProbe struct {
	once        sync.Once
	err         error
	unavailable bool
}

func requireExecutableNamespaceTest(t *testing.T) {
	t.Helper()
	executableNamespaceProbe.once.Do(func() {
		cmd := exec.Command(os.Args[0], "-test.run=^TestExecutableNamespaceCapabilityProbe$")
		cmd.Env = append(os.Environ(), "GO2GS_NAMESPACE_CAPABILITY_PROBE=1")
		if err := configureAnalysisWorkerNamespace(cmd); err != nil {
			executableNamespaceProbe.err = err
			return
		}
		var output bytes.Buffer
		cmd.Stdout = &output
		cmd.Stderr = &output
		if err := cmd.Start(); err != nil {
			executableNamespaceProbe.err = err
			executableNamespaceProbe.unavailable = namespaceChildStartUnavailable(err)
			return
		}
		err := cmd.Wait()
		if err != nil {
			message := strings.TrimSpace(output.String())
			executableNamespaceProbe.err = fmt.Errorf("%w: %s", err, message)
			executableNamespaceProbe.unavailable = executableNamespaceMountUnavailable(message)
		}
	})
	if executableNamespaceProbe.err != nil {
		if executableNamespaceProbe.unavailable {
			t.Skipf("private executable namespace unavailable: %v", executableNamespaceProbe.err)
		}
		t.Fatalf("private executable namespace probe failed unexpectedly: %v", executableNamespaceProbe.err)
	}
}

func TestExecutableNamespaceCapabilityProbe(t *testing.T) {
	if os.Getenv("GO2GS_NAMESPACE_CAPABILITY_PROBE") != "1" {
		t.Skip("internal executable namespace capability probe")
	}
	t.Setenv("GO2GS_EXEC_NAMESPACE", "1")
	root, err := secureRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	capsule, err := createExecutableCapsule(root, []capturedExecutable{{
		name: "probe", data: []byte("#!/bin/sh\nexit 0\n"), mode: 0o755,
	}}, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := capsule.close(); err != nil {
		t.Fatal(err)
	}
}

func enterExecutableNamespaceTest(t *testing.T) bool {
	t.Helper()
	if os.Getenv("GO2GS_NAMESPACE_TEST") == t.Name() {
		return true
	}
	requireExecutableNamespaceTest(t)
	socketRoot, err := os.MkdirTemp(".", ".go2gs-namespace-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketRoot)
	socketPath := filepath.Join(socketRoot, "attack.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	attackDone := make(chan error, 1)
	go serveNamespaceAttacks(listener, attackDone)

	cmd := exec.Command(os.Args[0], "-test.run=^"+regexp.QuoteMeta(t.Name())+"$")
	cmd.Env = append(os.Environ(),
		"GO2GS_EXEC_NAMESPACE=1",
		"GO2GS_NAMESPACE_TEST="+t.Name(),
		"GO2GS_TEST_ATTACK_SOCKET="+socketPath,
	)
	if err := configureAnalysisWorkerNamespace(cmd); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		_ = listener.Close()
		<-attackDone
		if namespaceChildStartUnavailable(err) {
			t.Skipf("private executable namespace adversarial harness unavailable: %v", err)
		}
		t.Fatalf("start namespace child: %v", err)
	}
	runErr := cmd.Wait()
	_ = listener.Close()
	if attackErr := <-attackDone; attackErr != nil {
		t.Fatal(attackErr)
	}
	if runErr != nil {
		message := strings.TrimSpace(output.String() + "\n" + runErr.Error())
		if executableNamespaceAttackSocketUnavailable(message) {
			t.Skipf("private executable namespace adversarial harness unavailable: %s", message)
		}
		t.Fatalf("namespace child failed: %v\n%s", runErr, output.String())
	}
	return false
}

func namespaceChildStartUnavailable(err error) bool {
	return errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES)
}

func executableNamespaceMountUnavailable(message string) bool {
	denied := strings.Contains(message, "operation not permitted") ||
		strings.Contains(message, "permission denied")
	return denied && (strings.Contains(message, "make executable mount namespace private") ||
		strings.Contains(message, "mount private executable tmpfs"))
}

func executableNamespaceAttackSocketUnavailable(message string) bool {
	denied := strings.Contains(message, "operation not permitted") ||
		strings.Contains(message, "permission denied")
	return denied && strings.Contains(message, "attack.sock")
}

func TestExecutableNamespaceUnavailableClassifiers(t *testing.T) {
	for _, test := range []struct {
		name    string
		message string
		mount   bool
		socket  bool
	}{
		{"hosted-mount", "make executable mount namespace private: permission denied", true, false},
		{"hosted-socket", "dial unix attack.sock: connect: permission denied", false, true},
		{"nested-exec", "fork/exec staged/go: operation not permitted", false, false},
		{"unrelated-file", "open profile.json: permission denied", false, false},
		{"product-error", "selected cmd/go hash changed", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := executableNamespaceMountUnavailable(test.message); got != test.mount {
				t.Fatalf("mount classification = %v, want %v for %q", got, test.mount, test.message)
			}
			if got := executableNamespaceAttackSocketUnavailable(test.message); got != test.socket {
				t.Fatalf("socket classification = %v, want %v for %q", got, test.socket, test.message)
			}
		})
	}
}

func serveNamespaceAttacks(listener net.Listener, done chan<- error) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				done <- nil
			} else {
				done <- err
			}
			return
		}
		scanner := bufio.NewScanner(connection)
		writer := bufio.NewWriter(connection)
		var attackedPath string
		for scanner.Scan() {
			command := strings.SplitN(scanner.Text(), "\t", 3)
			switch command[0] {
			case "swap":
				if len(command) != 3 {
					err = errors.New("invalid swap command")
					break
				}
				attackedPath = command[1]
				body := "#!/bin/sh\n: > " + strconv.Quote(command[2]) + "\nexit 91\n"
				err = os.WriteFile(attackedPath, []byte(body), 0o755)
			case "restore":
				err = os.Remove(attackedPath)
			default:
				err = errors.New("invalid attack command")
			}
			if err != nil {
				break
			}
			if _, err = writer.WriteString("ok\n"); err == nil {
				err = writer.Flush()
			}
			if err != nil {
				break
			}
		}
		_ = connection.Close()
		if err != nil {
			done <- err
			return
		}
	}
}

func attackHostPath(t *testing.T, connection net.Conn, reader *bufio.Reader, command string) {
	t.Helper()
	if _, err := connection.Write([]byte(command + "\n")); err != nil {
		t.Fatal(err)
	}
	if response, err := reader.ReadString('\n'); err != nil || response != "ok\n" {
		t.Fatalf("host attack failed: %q, %v", response, err)
	}
}
