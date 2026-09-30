// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"bufio"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func enterExecutableNamespaceTest(t *testing.T) bool {
	t.Helper()
	if os.Getenv("GO2GS_NAMESPACE_TEST") == t.Name() {
		return true
	}
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
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := configureAnalysisWorkerNamespace(cmd); err != nil {
		t.Fatal(err)
	}
	runErr := cmd.Run()
	_ = listener.Close()
	if attackErr := <-attackDone; attackErr != nil {
		t.Fatal(attackErr)
	}
	if runErr != nil {
		t.Fatal(runErr)
	}
	return false
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
