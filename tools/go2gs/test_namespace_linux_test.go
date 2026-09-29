// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if launched, err := maybeRunCompilerLauncher(); launched {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(127)
		}
		return
	}
	if os.Getenv("GO2GS_PROCESS_HELPER") != "" {
		os.Exit(m.Run())
	}
	if os.Getenv("GO2GS_EXEC_NAMESPACE") == "1" {
		os.Exit(m.Run())
	}
	socketRoot, err := os.MkdirTemp("", "go2gs-namespace-test-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	socketPath := filepath.Join(socketRoot, "attack.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	attackDone := make(chan error, 1)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				if errors.Is(err, net.ErrClosed) {
					attackDone <- nil
					return
				}
				attackDone <- err
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
						_ = connection.Close()
						attackDone <- fmt.Errorf("invalid swap command")
						return
					}
					attackedPath = command[1]
					body := "#!/bin/sh\n: > " + strconv.Quote(command[2]) + "\nexit 91\n"
					err = os.WriteFile(attackedPath, []byte(body), 0o755)
				case "restore":
					err = os.Remove(attackedPath)
				default:
					err = fmt.Errorf("invalid attack command")
				}
				if err != nil {
					_ = connection.Close()
					attackDone <- err
					return
				}
				if _, err = writer.WriteString("ok\n"); err == nil {
					err = writer.Flush()
				}
				if err != nil {
					_ = connection.Close()
					attackDone <- err
					return
				}
			}
			if err := scanner.Err(); err != nil {
				_ = connection.Close()
				attackDone <- err
				return
			}
			_ = connection.Close()
		}
	}()
	cmd := exec.Command(os.Args[0], os.Args[1:]...)
	cmd.Env = append(os.Environ(),
		"GO2GS_EXEC_NAMESPACE=1",
		"GO2GS_TEST_ATTACK_SOCKET="+socketPath,
	)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := configureAnalysisWorkerNamespace(cmd, true); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	runErr := cmd.Run()
	_ = listener.Close()
	attackErr := <-attackDone
	_ = os.Remove(socketPath)
	_ = os.Remove(socketRoot)
	if attackErr != nil {
		fmt.Fprintln(os.Stderr, attackErr)
		os.Exit(2)
	}
	if runErr != nil {
		err := runErr
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}
