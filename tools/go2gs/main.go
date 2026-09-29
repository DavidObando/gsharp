// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	schemaName     = "go2gs.analysis"
	schemaVersion  = 1
	profileName    = "go2gs.profile"
	profileVersion = 1
	helperVersion  = "0.1.0"
	toolVersion    = "0.1.0"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "analyze":
		err = runAnalyze(ctx, os.Args[2:])
	case "internal-analyze-worker":
		err = runAnalyzeWorker(ctx, os.Args[2:])
	case "validate-analysis":
		err = runValidate(os.Args[2:])
	case "version":
		fmt.Printf("go2gs %s (helper %s, schema %d)\n", toolVersion, helperVersion, schemaVersion)
		return
	default:
		usage()
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintln(os.Stderr, "go2gs:", err)
		var exitErr *exitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.code)
		}
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage:")
	fmt.Fprintln(os.Stderr, "  go2gs analyze --source DIR --profile FILE --out DIR")
	fmt.Fprintln(os.Stderr, "  go2gs validate-analysis --analysis FILE")
	fmt.Fprintln(os.Stderr, "  go2gs version")
}

type exitError struct {
	code int
	err  error
}

func (e *exitError) Error() string { return e.err.Error() }
func (e *exitError) Unwrap() error { return e.err }

func parseAnalyzeArgs(args []string) (string, string, string, error) {
	fs := flag.NewFlagSet("analyze", flag.ContinueOnError)
	source := fs.String("source", "", "source or module root")
	profilePath := fs.String("profile", "", "profile JSON")
	out := fs.String("out", "", "artifact directory")
	if err := fs.Parse(args); err != nil {
		return "", "", "", err
	}
	if *source == "" || *profilePath == "" || *out == "" || fs.NArg() != 0 {
		return "", "", "", errors.New("--source, --profile, and --out are required")
	}
	return *source, *profilePath, *out, nil
}

func runAnalyze(parent context.Context, args []string) error {
	source, profilePath, out, err := parseAnalyzeArgs(args)
	if err != nil {
		return &exitError{2, err}
	}
	outRoot, err := filepath.Abs(out)
	if err != nil {
		return &exitError{2, err}
	}
	if err := os.MkdirAll(outRoot, 0o755); err != nil {
		return &exitError{2, err}
	}
	if err := rejectSymlinkPath(outRoot); err != nil {
		return &exitError{2, fmt.Errorf("output root: %w", err)}
	}
	release, err := lockAndInvalidateOutput(outRoot)
	if err != nil {
		return &exitError{2, err}
	}
	defer release()

	profile, err := readProfile(profilePath)
	if err != nil {
		return &exitError{2, err}
	}
	sourceRoot, err := secureRoot(source)
	if err != nil {
		return &exitError{2, fmt.Errorf("source root: %w", err)}
	}
	goExecutable, err := exec.LookPath("go")
	if err != nil {
		return &exitError{2, errors.New("Go executable not found")}
	}
	goExecutable, err = filepath.Abs(goExecutable)
	if err != nil {
		return &exitError{2, err}
	}
	timeout := time.Duration(profile.Limits.MaxDurationSeconds) * time.Second
	bootstrapRoot, err := os.MkdirTemp(outRoot, ".go2gs-bootstrap-*")
	if err != nil {
		return &exitError{2, err}
	}
	defer os.RemoveAll(bootstrapRoot)
	versionResult, err := runProcess(parent, min(timeout, 15*time.Second), profile.Limits.MaxLogBytes,
		sourceRoot, goExecutable, []string{"version"}, bootstrapEnvironment(bootstrapRoot, goExecutable))
	if err != nil {
		return &exitError{2, err}
	}
	if versionResult.ExitCode != 0 {
		return &exitError{2, fmt.Errorf("resolve selected Go version: %s", strings.TrimSpace(versionResult.Stderr))}
	}
	if parseGoVersion(versionResult.Stdout) == "" {
		return &exitError{2, errors.New("selected Go executable returned an unrecognized version")}
	}
	workerRoot, err := os.MkdirTemp(outRoot, ".go2gs-worker-*")
	if err != nil {
		return &exitError{2, err}
	}
	defer os.RemoveAll(workerRoot)
	profileBytes, err := marshalCanonical(profile)
	if err != nil {
		return &exitError{2, err}
	}
	workerProfile := filepath.Join(workerRoot, "profile.json")
	if err := atomicWrite(workerProfile, profileBytes, 0o600); err != nil {
		return &exitError{2, err}
	}
	self, err := os.Executable()
	if err != nil {
		return &exitError{2, err}
	}
	result, err := runAnalysisWorkerProcess(parent, timeout, profile.Limits.MaxLogBytes, sourceRoot, self, []string{
		"internal-analyze-worker", "--source", sourceRoot, "--profile", workerProfile, "--out", workerRoot,
	}, bootstrapEnvironment(workerRoot, goExecutable))
	if err != nil {
		return &exitError{2, err}
	}
	if result.StdoutTruncated || result.StderrTruncated {
		return &exitError{2, errors.New("analysis worker output exceeded configured log limit")}
	}
	if result.ExitCode != 0 && result.ExitCode != 1 {
		return &exitError{2, fmt.Errorf("analysis worker failed: %s", strings.TrimSpace(result.Stderr))}
	}
	analysisBytes, runBytes, analysis, err := readWorkerArtifacts(workerRoot, profile.Limits.MaxOutputBytes)
	if err != nil {
		return &exitError{2, err}
	}
	if (result.ExitCode == 0) != analysis.InventoryComplete {
		return &exitError{2, errors.New("analysis worker exit status disagrees with inventory completeness")}
	}
	if err := publishWorkerArtifacts(outRoot, analysisBytes, runBytes, nil); err != nil {
		return &exitError{2, err}
	}
	if result.ExitCode == 1 {
		return &exitError{1, errors.New("inventory incomplete; see analysis.json diagnostics and blockers")}
	}
	return nil
}

func runAnalysisWorkerProcess(parent context.Context, timeout time.Duration, maxOutput int, dir, executable string, args, env []string) (processResult, error) {
	return runProcess(parent, timeout, maxOutput, dir, executable, args, env)
}

func runAnalyzeWorker(parent context.Context, args []string) error {
	source, profilePath, out, err := parseAnalyzeArgs(args)
	if err != nil {
		return &exitError{2, err}
	}
	profile, err := readProfile(profilePath)
	if err != nil {
		return &exitError{2, err}
	}
	sourceRoot, err := secureRoot(source)
	if err != nil {
		return &exitError{2, fmt.Errorf("source root: %w", err)}
	}
	outRoot, err := filepath.Abs(out)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(outRoot, 0o700); err != nil {
		return err
	}
	if err := rejectSymlinkPath(outRoot); err != nil {
		return fmt.Errorf("output root: %w", err)
	}

	timeout := time.Duration(profile.Limits.MaxDurationSeconds) * time.Second
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	started := time.Now()
	before := peakRSS()

	analysis, complete, err := analyze(ctx, sourceRoot, outRoot, profile)
	if err != nil {
		return &exitError{2, err}
	}
	analysisBytes, err := writeAnalysis(filepath.Join(outRoot, "analysis.json"), analysis, profile.Limits.MaxOutputBytes)
	if err != nil {
		return err
	}
	run := RunMetadata{
		SchemaVersion:       schemaVersion,
		ColdLoadNanoseconds: time.Since(started).Nanoseconds(),
		WarmLoadMeasured:    false,
		WarmLoadReason:      "M0 records the first isolated load only; a second load would mix Go build-cache effects with helper warmup",
		PeakRSSBytes:        max64(before, peakRSS()),
		AnalysisBytes:       int64(analysisBytes),
		PackageCount:        len(analysis.Packages),
		RecordCount:         analysis.RecordCounts.Total,
	}
	if err := writeJSON(filepath.Join(outRoot, "run.json"), run, profile.Limits.MaxOutputBytes); err != nil {
		return err
	}
	if !complete {
		return &exitError{1, errors.New("inventory incomplete; see analysis.json diagnostics and blockers")}
	}
	return nil
}

func runValidate(args []string) error {
	fs := flag.NewFlagSet("validate-analysis", flag.ContinueOnError)
	path := fs.String("analysis", "", "analysis JSON")
	if err := fs.Parse(args); err != nil {
		return &exitError{2, err}
	}
	if *path == "" || fs.NArg() != 0 {
		return &exitError{2, errors.New("--analysis is required")}
	}
	analysis, err := readAnalysis(*path)
	if err != nil {
		return &exitError{2, err}
	}
	if err := validateAnalysis(analysis); err != nil {
		return &exitError{2, err}
	}
	return nil
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
