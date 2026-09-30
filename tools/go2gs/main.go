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

	unsupportedExecutionBinding = "public analyze requires Linux descriptor-bound immutable cmd/go execution; secure execution binding is unsupported on this platform"
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

func runAnalyze(parent context.Context, args []string) (err error) {
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
	output, err := lockAndInvalidateOutput(outRoot)
	if err != nil {
		return &exitError{2, err}
	}
	defer func() {
		if releaseErr := output.release(); releaseErr != nil {
			err = joinOutputReleaseError(err, releaseErr)
		}
	}()

	profile, err := readProfile(profilePath)
	if err != nil {
		return &exitError{2, err}
	}
	sourceRoot, err := secureRoot(source)
	if err != nil {
		return &exitError{2, fmt.Errorf("source root: %w", err)}
	}
	if err := publicAnalysisBindingSupported(); err != nil {
		analysis, complete, analyzeErr := analyzePreload(parent, sourceRoot, outRoot, profile)
		if analyzeErr != nil {
			return &exitError{2, analyzeErr}
		}
		if complete {
			return &exitError{2, errors.New("preload-only analysis unexpectedly completed")}
		}
		run := RunMetadata{
			SchemaVersion:    schemaVersion,
			WarmLoadMeasured: false,
			WarmLoadReason:   "preload-only analysis returned before package loading on a platform without secure execution binding",
		}
		analysisBytes, runBytes, encodeErr := encodeAnalysisArtifacts(analysis, run, profile.Limits.MaxOutputBytes)
		if encodeErr != nil {
			return &exitError{2, encodeErr}
		}
		if publishErr := publishWorkerArtifacts(output, analysisBytes, runBytes, nil); publishErr != nil {
			return &exitError{2, publishErr}
		}
		return &exitError{1, errors.New("inventory incomplete; see analysis.json diagnostics and blockers")}
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
	bootstrapDirectory, err := createOwnedTempDir("", ".go2gs-bootstrap-*")
	if err != nil {
		return &exitError{2, err}
	}
	defer func() {
		if cleanupErr := ownedTempCleanupError(bootstrapDirectory, "bootstrap"); cleanupErr != nil {
			err = errors.Join(err, &exitError{2, cleanupErr})
		}
	}()
	bootstrapRoot := bootstrapDirectory.path
	goExecutableCapture, goExecutableHash, err := captureSelectedGo(goExecutable, "")
	if err != nil {
		return &exitError{2, fmt.Errorf("capture Go executable: %w", err)}
	}
	bootstrapCapsule, err := createExecutableCapsule(
		bootstrapRoot, []capturedExecutable{goExecutableCapture}, false,
	)
	if err != nil {
		return &exitError{2, err}
	}
	defer func() {
		if cleanupErr := bootstrapCapsule.close(); cleanupErr != nil {
			err = errors.Join(err, &exitError{2, cleanupErr})
		}
	}()
	stagedGo := bootstrapCapsule.path(goExecutableCapture.name)
	selectedGOROOT, err := selectedGoRoot(goExecutableCapture, "")
	if err != nil {
		return &exitError{2, err}
	}
	workerDirectory, err := createOwnedTempDir("", ".go2gs-worker-*")
	if err != nil {
		return &exitError{2, err}
	}
	defer func() {
		if cleanupErr := ownedTempCleanupError(workerDirectory, "worker"); cleanupErr != nil {
			err = errors.Join(err, &exitError{2, cleanupErr})
		}
	}()
	workerRoot := workerDirectory.path
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
	}, analysisWorkerEnvironment(bootstrapRoot, stagedGo, goExecutableHash, selectedGOROOT))
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
	if err := publishWorkerArtifacts(output, analysisBytes, runBytes, nil); err != nil {
		return &exitError{2, err}
	}
	if result.ExitCode == 1 {
		return &exitError{1, errors.New("inventory incomplete; see analysis.json diagnostics and blockers")}
	}
	return nil
}

func runAnalysisWorkerProcess(parent context.Context, timeout time.Duration, maxOutput int, dir, executable string, args, env []string) (processResult, error) {
	return runProcessConfigured(
		parent, timeout, maxOutput, dir, executable, args, env, processGroupOwn,
		configureAnalysisWorkerNamespace,
	)
}

func runAnalyzeWorker(parent context.Context, args []string) (err error) {
	parent = inheritProcessGroup(parent)
	if os.Getenv("GO2GS_SELECTED_GO") == "" ||
		os.Getenv("GO2GS_SELECTED_GO_SHA256") == "" ||
		os.Getenv("GO2GS_SELECTED_GOROOT") == "" ||
		os.Getenv("GO2GS_EXEC_NAMESPACE") != "1" {
		return &exitError{2, errors.New("analysis worker requires the private descriptor-bound selected Go handoff")}
	}
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
	output, err := lockAndInvalidateOutput(outRoot)
	if err != nil {
		return err
	}
	defer func() {
		if releaseErr := output.release(); releaseErr != nil {
			err = joinOutputReleaseError(err, releaseErr)
		}
	}()

	timeout := time.Duration(profile.Limits.MaxDurationSeconds) * time.Second
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	started := time.Now()
	before := peakRSS()

	analysis, complete, err := analyze(ctx, sourceRoot, outRoot, profile)
	if err != nil {
		return &exitError{2, err}
	}
	run := RunMetadata{
		SchemaVersion:       schemaVersion,
		ColdLoadNanoseconds: time.Since(started).Nanoseconds(),
		WarmLoadMeasured:    false,
		WarmLoadReason:      "M0 records the first isolated load only; a second load would mix Go build-cache effects with helper warmup",
		PeakRSSBytes:        max64(before, peakRSS()),
	}
	analysisBytes, runBytes, err := encodeAnalysisArtifacts(analysis, run, profile.Limits.MaxOutputBytes)
	if err != nil {
		return err
	}
	if err := publishWorkerArtifacts(output, analysisBytes, runBytes, nil); err != nil {
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

func joinOutputReleaseError(commandErr, releaseErr error) error {
	return errors.Join(
		&exitError{2, fmt.Errorf("release output lock: %w", releaseErr)},
		commandErr,
	)
}
