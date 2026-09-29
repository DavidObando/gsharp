// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func readProfile(path string) (Profile, error) {
	var profile Profile
	data, err := os.ReadFile(path)
	if err != nil {
		return profile, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&profile); err != nil {
		return profile, fmt.Errorf("invalid profile: %w", err)
	}
	if profile.Schema.Name != profileName || profile.Schema.Version != profileVersion {
		return profile, fmt.Errorf("unsupported profile schema %q version %d", profile.Schema.Name, profile.Schema.Version)
	}
	if profile.ID == "" || len(profile.EntryPatterns) == 0 || profile.RequestedGoVersion == "" {
		return profile, errors.New("profile id, entryPatterns, and requestedGoVersion are required")
	}
	if profile.AllowNetwork || !profile.Offline {
		return profile, errors.New("M0 accepts offline profiles only")
	}
	if profile.AllowGOPACKAGESDRIVER {
		return profile, errors.New("M0 does not allow GOPACKAGESDRIVER")
	}
	if profile.ModuleMode != "readonly" && profile.ModuleMode != "vendor" {
		return profile, errors.New("moduleMode must be readonly or vendor")
	}
	if profile.WorkspaceMode != "off" {
		return profile, errors.New("M0 requires workspaceMode=off")
	}
	if err := validateLimits(profile.Limits); err != nil {
		return profile, err
	}
	sort.Strings(profile.EntryPatterns)
	sort.Strings(profile.ArchitectureFeatures)
	sort.Strings(profile.BuildTags)
	sort.Strings(profile.GOFLAGS)
	return profile, nil
}

func validateLimits(l Limits) error {
	if l.MaxDurationSeconds <= 0 || l.MaxDurationSeconds > 3600 ||
		l.MaxPackages <= 0 || l.MaxFiles <= 0 || l.MaxRecords <= 0 ||
		l.MaxStringBytes <= 0 || l.MaxLogBytes <= 0 ||
		l.MaxOutputBytes <= 0 || l.MaxLocalHashBytes <= 0 {
		return errors.New("all resource limits must be positive and maxDurationSeconds must be <= 3600")
	}
	return nil
}

func readAnalysis(path string) (Analysis, error) {
	var analysis Analysis
	data, err := os.ReadFile(path)
	if err != nil {
		return analysis, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&analysis); err != nil {
		return analysis, fmt.Errorf("invalid analysis: %w", err)
	}
	return analysis, nil
}

func writeAnalysis(path string, analysis Analysis, maxBytes int64) (int, error) {
	if err := validateAnalysis(analysis); err != nil {
		return 0, fmt.Errorf("internal schema validation failed: %w", err)
	}
	data, err := marshalCanonical(analysis)
	if err != nil {
		return 0, err
	}
	if int64(len(data)) > maxBytes {
		return 0, fmt.Errorf("analysis output %d bytes exceeds limit %d", len(data), maxBytes)
	}
	if err := atomicWrite(path, data, 0o644); err != nil {
		return 0, err
	}
	return len(data), nil
}

func writeJSON(path string, value any, maxBytes int64) error {
	data, err := marshalCanonical(value)
	if err != nil {
		return err
	}
	if int64(len(data)) > maxBytes {
		return fmt.Errorf("output %d bytes exceeds limit %d", len(data), maxBytes)
	}
	return atomicWrite(path, data, 0o644)
}

func marshalCanonical(value any) ([]byte, error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	staged := filepath.Join(dir, "."+filepath.Base(path)+".staged")
	if err := os.WriteFile(staged, data, mode); err != nil {
		return err
	}
	if err := os.Rename(staged, path); err != nil {
		_ = os.Remove(staged)
		return err
	}
	return nil
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hashFile(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	h := sha256.New()
	n, err := io.Copy(h, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func stableID(kind, canonical string) string {
	sum := sha256.Sum256([]byte(kind + "\x00" + canonical))
	return kind + ":" + hex.EncodeToString(sum[:16])
}

func truncate(value string, max int) (string, bool) {
	if len(value) <= max {
		return value, false
	}
	if max <= 3 {
		return value[:max], true
	}
	return value[:max-3] + "...", true
}

func slash(path string) string {
	return filepath.ToSlash(filepath.Clean(path))
}

func canonicalEnv(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+values[key])
	}
	return out
}

func joinNonEmpty(values ...string) string {
	var result []string
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	return strings.Join(result, "\n")
}
