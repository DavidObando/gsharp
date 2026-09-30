// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type architectureSettings struct {
	variable string
	value    string
	toolTags []string
}

// Keep this list aligned with the pinned Go 1.27.1 helper's "go tool dist list".
var supportedGoTargets = map[string]bool{
	"aix/ppc64":   true,
	"android/386": true, "android/amd64": true, "android/arm": true, "android/arm64": true,
	"darwin/amd64": true, "darwin/arm64": true,
	"dragonfly/amd64": true,
	"freebsd/386":     true, "freebsd/amd64": true, "freebsd/arm": true, "freebsd/arm64": true,
	"illumos/amd64": true,
	"ios/amd64":     true, "ios/arm64": true,
	"js/wasm":   true,
	"linux/386": true, "linux/amd64": true, "linux/arm": true, "linux/arm64": true,
	"linux/loong64": true, "linux/mips": true, "linux/mips64": true, "linux/mips64le": true,
	"linux/mipsle": true, "linux/ppc64": true, "linux/ppc64le": true, "linux/riscv64": true,
	"linux/s390x": true,
	"netbsd/386":  true, "netbsd/amd64": true, "netbsd/arm": true, "netbsd/arm64": true,
	"openbsd/386": true, "openbsd/amd64": true, "openbsd/arm": true, "openbsd/arm64": true,
	"openbsd/ppc64": true, "openbsd/riscv64": true,
	"plan9/386": true, "plan9/amd64": true, "plan9/arm": true,
	"solaris/amd64": true,
	"wasip1/wasm":   true,
	"windows/386":   true, "windows/amd64": true, "windows/arm64": true,
}

func validateGoTarget(goos, goarch string) error {
	if supportedGoTargets[goos+"/"+goarch] {
		return nil
	}
	knownOS, knownArch := false, false
	for target := range supportedGoTargets {
		os, arch, _ := strings.Cut(target, "/")
		knownOS = knownOS || os == goos
		knownArch = knownArch || arch == goarch
	}
	switch {
	case !knownOS:
		return fmt.Errorf("unsupported GOOS %q for Go 1.27.1", goos)
	case !knownArch:
		return fmt.Errorf("unsupported GOARCH %q for Go 1.27.1", goarch)
	default:
		return fmt.Errorf("unsupported Go 1.27.1 target %s/%s", goos, goarch)
	}
}

func resolveArchitectureSettings(goarch string, features []string) (architectureSettings, error) {
	single := func(variable, fallback string, valid map[string]bool, tags func(string) []string) (architectureSettings, error) {
		value := fallback
		if len(features) > 1 {
			return architectureSettings{}, fmt.Errorf("%s accepts exactly one architecture feature value", variable)
		}
		if len(features) == 1 {
			value = features[0]
		}
		if !valid[value] {
			return architectureSettings{}, fmt.Errorf("invalid %s value %q", variable, value)
		}
		return architectureSettings{variable: variable, value: value, toolTags: tags(value)}, nil
	}
	exact := func(prefix string) func(string) []string {
		return func(value string) []string { return []string{prefix + "." + value} }
	}
	switch goarch {
	case "386":
		return single("GO386", "sse2", valueSet("softfloat", "sse2"), exact("386"))
	case "amd64":
		return single("GOAMD64", "v1", valueSet("v1", "v2", "v3", "v4"), func(value string) []string {
			level := int(value[1] - '0')
			tags := make([]string, 0, level)
			for current := 1; current <= level; current++ {
				tags = append(tags, fmt.Sprintf("amd64.v%d", current))
			}
			return tags
		})
	case "arm":
		level, float, err := resolveARMFeatures(features)
		if err != nil {
			return architectureSettings{}, err
		}
		tags := make([]string, 0, level-4)
		for current := 5; current <= level; current++ {
			tags = append(tags, fmt.Sprintf("arm.%d", current))
		}
		return architectureSettings{variable: "GOARM", value: strconv.Itoa(level) + "," + float, toolTags: tags}, nil
	case "arm64":
		version, options, err := resolveARM64Features(features)
		if err != nil {
			return architectureSettings{}, err
		}
		major := int(version[1] - '0')
		minor := int(version[3] - '0')
		var tags []string
		for current := 0; current <= minor; current++ {
			tags = append(tags, fmt.Sprintf("arm64.v%d.%d", major, current))
		}
		if major == 9 {
			for current := 0; current <= minor+5 && current <= 9; current++ {
				tags = append(tags, fmt.Sprintf("arm64.v8.%d", current))
			}
		}
		value := version
		if len(options) > 0 {
			value += "," + strings.Join(options, ",")
		}
		return architectureSettings{variable: "GOARM64", value: value, toolTags: tags}, nil
	case "mips", "mipsle":
		return single("GOMIPS", "hardfloat", valueSet("hardfloat", "softfloat"), exact(goarch))
	case "mips64", "mips64le":
		return single("GOMIPS64", "hardfloat", valueSet("hardfloat", "softfloat"), exact(goarch))
	case "ppc64", "ppc64le":
		return single("GOPPC64", "power8", valueSet("power8", "power9", "power10"), func(value string) []string {
			level, _ := strconv.Atoi(strings.TrimPrefix(value, "power"))
			var tags []string
			for current := 8; current <= level; current++ {
				tags = append(tags, fmt.Sprintf("%s.power%d", goarch, current))
			}
			return tags
		})
	case "riscv64":
		return single("GORISCV64", "rva20u64", valueSet("rva20u64", "rva22u64", "rva23u64"), func(value string) []string {
			tags := []string{"riscv64.rva20u64"}
			if value == "rva22u64" || value == "rva23u64" {
				tags = append(tags, "riscv64.rva22u64")
			}
			if value == "rva23u64" {
				tags = append(tags, "riscv64.rva23u64")
			}
			return tags
		})
	case "wasm":
		seen := map[string]bool{}
		for _, feature := range features {
			if feature != "satconv" && feature != "signext" {
				return architectureSettings{}, fmt.Errorf("invalid GOWASM feature %q", feature)
			}
			if seen[feature] {
				return architectureSettings{}, fmt.Errorf("duplicate GOWASM feature %q", feature)
			}
			seen[feature] = true
		}
		return architectureSettings{
			variable: "GOWASM", value: strings.Join(uniqueSorted(features), ","),
			toolTags: []string{"wasm.satconv", "wasm.signext"},
		}, nil
	default:
		if len(features) != 0 {
			return architectureSettings{}, fmt.Errorf("GOARCH %s does not define architecture feature values", goarch)
		}
		return architectureSettings{}, nil
	}
}

func resolveARMFeatures(features []string) (int, string, error) {
	level, float := 7, "hardfloat"
	haveLevel, haveFloat := false, false
	for _, feature := range features {
		switch feature {
		case "5", "6", "7":
			if haveLevel {
				return 0, "", errors.New("GOARM accepts one architecture level")
			}
			level, _ = strconv.Atoi(feature)
			haveLevel = true
		case "softfloat", "hardfloat":
			if haveFloat {
				return 0, "", errors.New("GOARM accepts one floating-point mode")
			}
			float, haveFloat = feature, true
		default:
			return 0, "", fmt.Errorf("invalid GOARM feature %q", feature)
		}
	}
	if !haveFloat && level == 5 {
		float = "softfloat"
	}
	return level, float, nil
}

func resolveARM64Features(features []string) (string, []string, error) {
	version := "v8.0"
	haveVersion := false
	options := map[string]bool{}
	for _, feature := range features {
		switch {
		case valueSet(
			"v8.0", "v8.1", "v8.2", "v8.3", "v8.4", "v8.5", "v8.6", "v8.7", "v8.8", "v8.9",
			"v9.0", "v9.1", "v9.2", "v9.3", "v9.4", "v9.5",
		)[feature]:
			if haveVersion {
				return "", nil, errors.New("GOARM64 accepts one architecture level")
			}
			version, haveVersion = feature, true
		case feature == "lse" || feature == "crypto":
			if options[feature] {
				return "", nil, fmt.Errorf("duplicate GOARM64 feature %q", feature)
			}
			options[feature] = true
		default:
			return "", nil, fmt.Errorf("invalid GOARM64 feature %q", feature)
		}
	}
	var ordered []string
	for _, option := range []string{"lse", "crypto"} {
		if options[option] {
			ordered = append(ordered, option)
		}
	}
	return version, ordered, nil
}

func valueSet(values ...string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}
