// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSourceMetadataBlockerIsRootIndependentAndBounded(t *testing.T) {
	analyzeFailure := func(t *testing.T) BlockerRecord {
		t.Helper()
		root, err := secureRoot(copyFixture(t, "complete"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(root, ".git"), 0o700); err != nil {
			t.Fatal(err)
		}
		profile := testProfile()
		profile.ExpectedSourceCommit = strings.Repeat("a", 40)
		profile.Limits.MaxStringBytes = 96
		analysis, complete, err := analyze(t.Context(), root, t.TempDir(), profile)
		if err != nil {
			t.Fatal(err)
		}
		if complete {
			t.Fatal("missing repository HEAD completed inventory")
		}
		for _, blocker := range analysis.Blockers {
			if blocker.Category == "source-metadata" &&
				strings.Contains(blocker.Message, "repository HEAD") {
				if strings.Contains(blocker.Message, root) {
					t.Fatalf("source root leaked in blocker: %q", blocker.Message)
				}
				assertPublishedBlocker(t, blocker, profile.Limits.MaxStringBytes)
				return blocker
			}
		}
		t.Fatalf("source metadata blocker missing: %#v", analysis.Blockers)
		return BlockerRecord{}
	}

	first := analyzeFailure(t)
	second := analyzeFailure(t)
	if first.Message != second.Message || first.ID != second.ID {
		t.Fatalf("checkout-dependent source blocker:\n%#v\n%#v", first, second)
	}
	if !strings.Contains(first.Message, ".git") || !strings.Contains(first.Message, "HEAD") ||
		!strings.Contains(first.Message, "<private-path>") {
		t.Fatalf("source blocker lost actionable relative context: %q", first.Message)
	}
}

func TestBlockerFinalizationBoundsEveryConstructionAPI(t *testing.T) {
	const max = 11
	for _, test := range []struct {
		name string
		add  func(*inventoryBuilder, string)
	}{
		{"inventory", func(builder *inventoryBuilder, message string) {
			builder.block("test-inventory", message, []string{"unit-b", "unit-a"}, nil)
		}},
		{"migration", func(builder *inventoryBuilder, message string) {
			builder.migrationBlock("test-migration", message, []string{"unit-b", "unit-a"})
		}},
		{"raw", func(builder *inventoryBuilder, message string) {
			builder.addBlocker("inventory", "test-raw", message, []string{"unit-b", "unit-a"}, []string{"diagnostic-b", "diagnostic-a"})
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := testProfile()
			profile.Limits.MaxStringBytes = max
			analysis := Analysis{Blockers: []BlockerRecord{}}
			builder := newInventoryBuilder(&analysis, "/private/source-mirror", "/private/goroot", profile)
			builder.diagnosticRedactions = []string{"/checkout/source", "/private/work", "/output/root"}
			message := test.name + "-\xff-/checkout/source-/private/source-mirror-/private/work-/output/root-" +
				strings.Repeat("界", 32)
			test.add(builder, message)
			if len(analysis.Blockers) != 1 {
				t.Fatalf("blocker count = %d", len(analysis.Blockers))
			}
			assertPublishedBlocker(t, analysis.Blockers[0], max)
			for _, root := range []string{"/checkout/source", "/private/source-mirror", "/private/work", "/output/root"} {
				if strings.Contains(analysis.Blockers[0].Message, root) {
					t.Fatalf("private root %q leaked in %q", root, analysis.Blockers[0].Message)
				}
			}
		})
	}
}

func TestLongRequestedGoVersionBlockerUsesPublishedMessageIdentity(t *testing.T) {
	profile := testProfile()
	profile.RequestedGoVersion = "1." + strings.Repeat("9", 512)
	if normalized, err := normalizeOfficialGoVersion(profile.RequestedGoVersion, false); err != nil ||
		normalized != profile.RequestedGoVersion {
		t.Fatalf("long canonical Go version rejected: %q, %v", normalized, err)
	}
	profile.Limits.MaxStringBytes = 17
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if complete {
		t.Fatal("toolchain mismatch completed inventory")
	}
	for _, blocker := range analysis.Blockers {
		if blocker.Category == "toolchain" {
			assertPublishedBlocker(t, blocker, profile.Limits.MaxStringBytes)
			return
		}
	}
	t.Fatalf("toolchain blocker missing: %#v", analysis.Blockers)
}

func TestBlockerFinalizationHandlesTinyStringLimits(t *testing.T) {
	for max := 1; max <= 3; max++ {
		t.Run(fmt.Sprintf("max-%d", max), func(t *testing.T) {
			profile := testProfile()
			profile.Limits.MaxStringBytes = max
			analysis := Analysis{Blockers: []BlockerRecord{}}
			builder := newInventoryBuilder(&analysis, "", "", profile)
			builder.block("tiny", strings.Repeat("界", 8), nil, nil)
			if len(analysis.Blockers) != 1 {
				t.Fatalf("blocker count = %d", len(analysis.Blockers))
			}
			assertPublishedBlocker(t, analysis.Blockers[0], max)
		})
	}
}

func TestBlockerDeduplicationUsesBoundedPublishedMessage(t *testing.T) {
	profile := testProfile()
	profile.Limits.MaxStringBytes = 8
	analysis := Analysis{Blockers: []BlockerRecord{}}
	builder := newInventoryBuilder(&analysis, "", "", profile)
	builder.block("dedupe", "shared-prefix-first", nil, nil)
	builder.block("dedupe", "shared-prefix-second", nil, nil)
	if len(analysis.Blockers) != 1 || builder.records != 1 {
		t.Fatalf("bounded-equivalent blockers were not deduplicated before counting: %#v, records=%d",
			analysis.Blockers, builder.records)
	}
	assertPublishedBlocker(t, analysis.Blockers[0], profile.Limits.MaxStringBytes)
}

func TestRecordedMessagePathRedactionIsComponentAware(t *testing.T) {
	for _, test := range []struct {
		name       string
		message    string
		redactions []messagePathRedaction
		want       string
	}{
		{
			name:       "unix lookalike prefix",
			message:    "/private/source-other/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "/private/source-other/file.go",
		},
		{
			name:    "nested private root wins",
			message: "/tmp/work-123/capsule-456/go",
			redactions: []messagePathRedaction{
				{"/tmp/work-123", "<private-path>"},
				{"/tmp/work-123/capsule-456/go", "<private-path>"},
			},
			want: "<private-path>",
		},
		{
			name:    "source beats parent work root",
			message: "open \"/tmp/work-123/source/.git/HEAD\": denied",
			redactions: []messagePathRedaction{
				{"/tmp/work-123", "<private-path>"},
				{"/tmp/work-123/source", "<source>"},
			},
			want: "open \"<source>/.git/HEAD\": denied",
		},
		{
			name:    "goroot beats parent capsule",
			message: "/tmp/work-123/capsule/go/pkg/tool",
			redactions: []messagePathRedaction{
				{"/tmp/work-123/capsule", "<private-path>"},
				{"/tmp/work-123/capsule/go", "<goroot>"},
			},
			want: "<goroot>/pkg/tool",
		},
		{
			name:       "windows drive aliases",
			message:    "c:/work/source/.git/HEAD",
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "<source>/.git/HEAD",
		},
		{
			name:       "windows lookalike prefix",
			message:    `C:\Work\Source-other\file.go`,
			redactions: []messagePathRedaction{{`c:/work/source`, "<source>"}},
			want:       `C:\Work\Source-other\file.go`,
		},
		{
			name:       "UNC case and separator aliases",
			message:    `open //server/share/SOURCE/.git/HEAD`,
			redactions: []messagePathRedaction{{`\\SERVER\SHARE\source`, "<source>"}},
			want:       "open <source>/.git/HEAD",
		},
		{
			name:       "quoted trailing separator",
			message:    `"/private/source/"`,
			redactions: []messagePathRedaction{{"/private/source/", "<source>"}},
			want:       `"<source>"`,
		},
		{
			name:       "significant trailing space",
			message:    `"/private/source /file.go"`,
			redactions: []messagePathRedaction{{"/private/source ", "<source>"}},
			want:       `"<source>/file.go"`,
		},
		{
			name:       "backtick wrapped",
			message:    "open `/private/source/file.go`",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "open `<source>/file.go`",
		},
		{
			name:       "invalid byte identity",
			message:    "/tmp/\xfe/file.go",
			redactions: []messagePathRedaction{{"/tmp/\xff", "<source>"}},
			want:       "/tmp/\xfe/file.go",
		},
		{
			name:       "matching invalid byte",
			message:    "/tmp/\xff/file.go",
			redactions: []messagePathRedaction{{"/tmp/\xff", "<source>"}},
			want:       "<source>/file.go",
		},
		{
			name:       "unix filesystem root",
			message:    "open /tmp/file",
			redactions: []messagePathRedaction{{"/", "<source>"}},
			want:       "open <source>/tmp/file",
		},
		{
			name:       "windows drive root",
			message:    `C:\Windows\go.exe`,
			redactions: []messagePathRedaction{{`c:\`, "<private-path>"}},
			want:       `<private-path>\Windows\go.exe`,
		},
		{
			name:    "deterministic equal-root priority",
			message: "/private/source/file.go",
			redactions: []messagePathRedaction{
				{"/private/source", "<private-path>"},
				{"/private/source", "<source>"},
			},
			want: "<source>/file.go",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := redactMessagePaths(test.message, test.redactions); got != test.want {
				t.Fatalf("redacted message = %q; want %q", got, test.want)
			}
		})
	}
}

func TestRecordedMessageURIPathRedaction(t *testing.T) {
	for _, test := range []struct {
		name       string
		message    string
		redactions []messagePathRedaction
		want       string
	}{
		{
			name:       "remote UNC-like authority unchanged",
			message:    "https://server/share/source/file",
			redactions: []messagePathRedaction{{`\\server\share\source`, "<source>"}},
			want:       "https://server/share/source/file",
		},
		{
			name:       "remote filesystem root unchanged",
			message:    "https://example.test/path",
			redactions: []messagePathRedaction{{"/", "<source>"}},
			want:       "https://example.test/path",
		},
		{
			name:       "remote drive-looking path unchanged",
			message:    "custom+ssh://example.test/C:/Work/Source/file.go",
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "custom+ssh://example.test/C:/Work/Source/file.go",
		},
		{
			name:       "one-letter scheme unchanged",
			message:    "x:/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "x:/private/source/file.go",
		},
		{
			name:       "remote URI and separate filesystem path",
			message:    "see https://example.test/private/source then /private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "see https://example.test/private/source then <source>/file.go",
		},
		{
			name:       "bracket wrapped URI and adjacent path",
			message:    "[https://example.test/private/source]/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "[https://example.test/private/source]<source>/file.go",
		},
		{
			name:       "parenthesis wrapped URI and adjacent path",
			message:    "(https://example.test/a_(b))/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "(https://example.test/a_(b))<source>/file.go",
		},
		{
			name:       "IPv6 authority inside bracket wrapper",
			message:    "[https://[2001:db8::1]/private/source]/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "[https://[2001:db8::1]/private/source]<source>/file.go",
		},
		{
			name:       "Unix file URI",
			message:    "file:///private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file://<source>/file.go",
		},
		{
			name:       "Windows file URI",
			message:    "file:///C:/Work/Source/file.go",
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "file:///<source>/file.go",
		},
		{
			name:       "Windows file URI aliases",
			message:    `FiLe:///c:\WORK\source\file.go`,
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       `FiLe:///<source>\file.go`,
		},
		{
			name:       "UNC file URI",
			message:    "file://server/share/source/file.go",
			redactions: []messagePathRedaction{{`\\SERVER\SHARE\source`, "<source>"}},
			want:       "file://<source>/file.go",
		},
		{
			name:       "localhost Unix file URI",
			message:    "file://localhost/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file://localhost/<source>/file.go",
		},
		{
			name:       "localhost Unix case alias",
			message:    "FiLe://LOCALHOST/private/source/file.go?mode=read#location",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "FiLe://LOCALHOST/<source>/file.go?mode=read#location",
		},
		{
			name:       "localhost Windows file URI",
			message:    `file://LOCALHOST/C:/Work/Source/file.go`,
			redactions: []messagePathRedaction{{`c:\work\source`, "<source>"}},
			want:       "file://LOCALHOST/<source>/file.go",
		},
		{
			name:       "localhost Windows separator alias",
			message:    "`file://localhost\\c:\\WORK\\source\\file.go`",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "`file://localhost\\<source>\\file.go`",
		},
		{
			name:       "drive authority file URI",
			message:    "file://C:/Work/Source/file.go",
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "file://<source>/file.go",
		},
		{
			name:       "drive authority case alias",
			message:    "FiLe://c:/WORK/source/file.go?mode=read#location",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "FiLe://<source>/file.go?mode=read#location",
		},
		{
			name:       "unmatched drive authority fails closed",
			message:    "file://D:/Public/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "wrapped unmatched drive authority alias fails closed",
			message:    "`FiLe://d:\\Public\\file.go?mode=read#location`",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "`file:<private-path>`",
		},
		{
			name:       "localhost unmatched drive path fails closed",
			message:    "file://localhost/D:/Public/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "local unmatched drive path fails closed",
			message:    "file:///D:/Public/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "single separator matching drive path",
			message:    "file:/C:/Work/Source/file.go",
			redactions: []messagePathRedaction{{`c:\work\source`, "<source>"}},
			want:       "file:/<source>/file.go",
		},
		{
			name:       "single backslash matching drive path",
			message:    `FiLe:\c:\WORK\source\file.go`,
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       `FiLe:\<source>\file.go`,
		},
		{
			name:       "single separator unmatched drive path fails closed",
			message:    "file:/D:/Public/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "single backslash unmatched drive path fails closed",
			message:    "`file:\\D:\\Public\\file.go?mode=read#location`",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "`file:<private-path>`",
		},
		{
			name:       "direct matching drive path",
			message:    "file:C:/Work/Source/file.go?mode=read#location",
			redactions: []messagePathRedaction{{`c:\work\source`, "<source>"}},
			want:       "file:<source>/file.go?mode=read#location",
		},
		{
			name:       "wrapped direct matching drive alias",
			message:    "`FiLe:c:\\WORK\\source\\file.go`",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "`FiLe:<source>\\file.go`",
		},
		{
			name:       "direct unmatched drive path fails closed",
			message:    "file:D:/Public/file.go?mode=read#location",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "four separator matching drive path fails closed",
			message:    "file:////C:/Work/Source/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "five separator matching drive path fails closed",
			message:    `FiLe:\\\\\c:\WORK\source\file.go`,
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "localhost unrelated path unchanged",
			message:    "file://localhost/public/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file://localhost/public/source/file.go",
		},
		{
			name:       "localhost configured UNC file URI",
			message:    "file://localhost/share/source/file.go",
			redactions: []messagePathRedaction{{`\\LOCALHOST\share\source`, "<source>"}},
			want:       "file://<source>/file.go",
		},
		{
			name:       "localhost port authority fails closed",
			message:    "FiLe://localhost:8080/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unknown authority fails closed",
			message:    "file://unknown/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unmatched UNC authority fails closed",
			message:    "file://server/public/source/file.go",
			redactions: []messagePathRedaction{{`\\other\share\source`, "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "encoded authority fails closed",
			message:    "file://local%68ost/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "localhost missing path fails closed",
			message:    "(file://localhost)",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "(file:<private-path>)",
		},
		{
			name:       "localhost repeated Unix separator fails closed",
			message:    "file://localhost/private//source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "localhost repeated drive separator fails closed",
			message:    "file://localhost/C://Work/Source/file.go",
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "drive authority repeated separator fails closed",
			message:    "file://C://Work/Source/file.go",
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "empty file URI fails closed",
			message:    "[FiLe:]",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "[file:<private-path>]",
		},
		{
			name:       "extra local file separators",
			message:    "file:////private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:///<source>/file.go",
		},
		{
			name:       "ambiguous extra separators fail closed",
			message:    "file:////public/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "Unix current component fails closed",
			message:    "file:///private/./source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "Unix parent component fails closed",
			message:    "file:///public/../private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "localhost current component fails closed",
			message:    "file://localhost/private/./source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "single separator parent component fails closed",
			message:    "file:/private/../private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "direct drive current component fails closed",
			message:    "file:C:/Work/./Source/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "single separator drive parent component fails closed",
			message:    "file:/C:/Work/../Work/Source/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "drive authority current component fails closed",
			message:    "file://C:/Work/./Source/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "triple separator drive parent component fails closed",
			message:    "file:///C:/Work/../Work/Source/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "localhost drive current component fails closed",
			message:    "file://localhost/C:/Work/./Source/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "UNC parent component fails closed",
			message:    "file://server/share/public/../source/file.go",
			redactions: []messagePathRedaction{{`\\server\share\source`, "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "backslash current component fails closed",
			message:    `file:\private\.\source\file.go`,
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "Unicode dot component fails closed",
			message:    "file:///private/\uFF0E/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "Unicode separator ambiguity fails closed",
			message:    "file:///private\uFF0Fsource/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "Unicode big solidus ambiguity fails closed",
			message:    "file:///private\u29F8source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "Unicode big reverse solidus ambiguity fails closed",
			message:    "file:///private\u29F9source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "Unicode set minus ambiguity fails closed",
			message:    "file:///private\u2216source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "Unicode letter path remains eligible",
			message:    "file:///public/r\u00E9sum\u00E9/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:///public/r\u00E9sum\u00E9/file.go",
		},
		{
			name:       "invalid UTF-8 after traversal fails closed",
			message:    "file:///public/../\xffsecret",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "wrapped invalid UTF-8 path fails closed",
			message:    "[file:///public/\xff/private/source]",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "[file:<private-path>]",
		},
		{
			name:       "raw whitespace path tail fails closed",
			message:    "file:///private source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unwrapped parenthesis tail fails closed",
			message:    "file:///public/file.go)/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unwrapped bracket tail fails closed",
			message:    "file:///public/file.go]/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unwrapped semicolon tail fails closed",
			message:    "file:///public/file.go;/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unwrapped double quote tail fails closed",
			message:    "file:///public/file.go\"/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unwrapped backtick tail fails closed",
			message:    "file:///public/file.go`/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unwrapped angle close tail fails closed",
			message:    "file:///public/file.go>/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unwrapped angle open tail fails closed",
			message:    "file:///public/file.go</private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "embedded drive component fails closed",
			message:    "file:///public/C:/Work/Source/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "localhost embedded drive component fails closed",
			message:    "file://localhost/public/C:/Work/Source/file.go",
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "single separator localhost drive component fails closed",
			message:    "file:/localhost/C:/Work/Source/file.go",
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "triple separator localhost drive component fails closed",
			message:    "file:///localhost/C:/Work/Source/file.go",
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "single backslash localhost drive component fails closed",
			message:    `file:\localhost\C:\Work\Source\file.go`,
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "triple backslash localhost drive component fails closed",
			message:    `file:\\\localhost\C:\Work\Source\file.go`,
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "wrapped path localhost drive component fails closed",
			message:    "`FiLe:///LOCALHOST/c:/WORK/source/file.go`",
			redactions: []messagePathRedaction{{`C:\Work\Source`, "<source>"}},
			want:       "`file:<private-path>`",
		},
		{
			name:       "raw tab path tail fails closed",
			message:    "file:///public\t/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unexpected at punctuation fails closed",
			message:    "file:///public/@scope/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "parenthesis wrapper terminates before adjacent path",
			message:    "(file:///public/file.go)/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "(file:///public/file.go)<source>/file.go",
		},
		{
			name:       "bracket wrapper terminates before adjacent path",
			message:    "[file:///public/file.go]/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "[file:///public/file.go]<source>/file.go",
		},
		{
			name:       "quote wrapper terminates before adjacent path",
			message:    "\"file:///public/file.go\"/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "\"file:///public/file.go\"<source>/file.go",
		},
		{
			name:       "angle wrapper terminates before adjacent path",
			message:    "<file:///public/file.go>/private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "<file:///public/file.go><source>/file.go",
		},
		{
			name:       "strict ASCII path components remain eligible",
			message:    "file:///public/.config/name-1_value~2/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:///public/.config/name-1_value~2/file.go",
		},
		{
			name:       "file URI query and fragment",
			message:    "`file:///private/source/file.go?mode=read#location`",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "`file://<source>/file.go?mode=read#location`",
		},
		{
			name:       "benign file URI suffix grammar",
			message:    "file:///private/source/file.go?mode=read&kind=inventory#location-1",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file://<source>/file.go?mode=read&kind=inventory#location-1",
		},
		{
			name:    "matching path query and fragment roots fail closed",
			message: "file:///private/source/file.go?other=/private/source/secret#C:/Work/Source",
			redactions: []messagePathRedaction{
				{"/private/source", "<source>"},
				{"C:/Work/Source", "<private-path>"},
			},
			want: "file:<private-path>",
		},
		{
			name:    "public path query and fragment roots fail closed",
			message: "file:///public/file.go?source=/private/source#drive=C:/Work/Source",
			redactions: []messagePathRedaction{
				{"/private/source", "<source>"},
				{"C:/Work/Source", "<private-path>"},
			},
			want: "file:<private-path>",
		},
		{
			name:       "localhost fragment root fails closed",
			message:    "file://localhost/public/file.go#/private/source/secret",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "suffix backslash fails closed",
			message:    `file:///public/file.go?path=C:\Work\Source`,
			redactions: []messagePathRedaction{{"C:/Work/Source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "encoded suffix fails closed",
			message:    "file:///public/file.go?path=%2Fprivate%2Fsource",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "ambiguous suffix delimiter fails closed",
			message:    "file:///public/file.go?mode=read?path",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "empty suffix component fails closed",
			message:    "file:///public/file.go?mode=read#",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "query parent token fails closed",
			message:    "file:///public/file.go?path=..",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "query current token fails closed",
			message:    "file:///public/file.go?path=.",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "fragment parent token fails closed",
			message:    "file:///public/file.go#..",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "repeated query component separator fails closed",
			message:    "file:///public/file.go?mode=read&&kind=x",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "leading query component separator fails closed",
			message:    "file:///public/file.go?&mode=read",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "trailing query component separator fails closed",
			message:    "file:///public/file.go?mode=read&",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "empty query key fails closed",
			message:    "file:///public/file.go?=read",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "duplicate query equals fails closed",
			message:    "file:///public/file.go?mode==read",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "key only query fails closed",
			message:    "file:///public/file.go?mode",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "duplicate query key fails closed",
			message:    "file:///public/file.go?mode=read&mode=write",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "Unicode query token fails closed",
			message:    "file:///public/file.go?mode=r\u00E9ad",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "unrelated file URI unchanged",
			message:    "file:///public/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:///public/source/file.go",
		},
		{
			name:       "percent encoded file URI fails closed",
			message:    "file:///private%2Fsource/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "relative file URI fails closed",
			message:    "file:private/source/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "file:<private-path>",
		},
		{
			name:       "remote percent encoding unchanged",
			message:    "https://example.test/private%2Fsource/file.go",
			redactions: []messagePathRedaction{{"/private/source", "<source>"}},
			want:       "https://example.test/private%2Fsource/file.go",
		},
		{
			name:    "remote path-bearing suffix unchanged",
			message: "https://example.test/file?source=/private/source#drive=C:/Work/Source",
			redactions: []messagePathRedaction{
				{"/private/source", "<source>"},
				{"C:/Work/Source", "<private-path>"},
			},
			want: "https://example.test/file?source=/private/source#drive=C:/Work/Source",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := redactMessagePaths(test.message, test.redactions); got != test.want {
				t.Fatalf("redacted URI message = %q; want %q", got, test.want)
			}
		})
	}
}

func TestBlockerPathAliasesPublishOneStableIdentity(t *testing.T) {
	profile := testProfile()
	profile.Limits.MaxStringBytes = 256
	build := func(sourceRoot, message string, privateRoots ...string) BlockerRecord {
		analysis := Analysis{Blockers: []BlockerRecord{}}
		builder := newInventoryBuilder(&analysis, sourceRoot, "", profile)
		builder.diagnosticRedactions = privateRoots
		builder.block("path-alias", message, nil, nil)
		if len(analysis.Blockers) != 1 {
			t.Fatalf("blocker count = %d", len(analysis.Blockers))
		}
		assertPublishedBlocker(t, analysis.Blockers[0], profile.Limits.MaxStringBytes)
		return analysis.Blockers[0]
	}

	first := build(`C:\Work\Source`, "c:/work/source/.git/HEAD")
	second := build("c:/work/source", "C:/WORK/SOURCE/.git/HEAD")
	if first.ID != second.ID || first.Message != second.Message {
		t.Fatalf("Windows path aliases changed blocker identity:\n%#v\n%#v", first, second)
	}
	nested := build("", "/tmp/work-123/capsule-456/go",
		"/tmp/work-123", "/tmp/work-123/capsule-456/go")
	if nested.Message != "<private-path>" {
		t.Fatalf("nested private suffix leaked into blocker identity: %#v", nested)
	}
	uri := build("/private/source", "file://localhost/private/source/.git/HEAD")
	if uri.Message != "file://localhost/<source>/.git/HEAD" {
		t.Fatalf("local file URI leaked into blocker identity: %#v", uri)
	}
	otherURI := build("/different/source", "file://localhost/different/source/.git/HEAD")
	if uri.ID != otherURI.ID {
		t.Fatalf("local file URI root aliases produced different blocker identities: %#v != %#v", uri, otherURI)
	}
	unknown := build("/private/source", "FiLe://unknown/private/source/.git/HEAD")
	unknownAlias := build("/different/source", "file://unknown/different/source/.git/HEAD")
	if unknown.Message != "file:<private-path>" || unknown.ID != unknownAlias.ID {
		t.Fatalf("ambiguous file URI aliases produced unstable blocker identities: %#v != %#v", unknown, unknownAlias)
	}
	suffix := build("/private/source", "file:///public/file.go?source=/private/source")
	suffixAlias := build("/different/source", "file:///public/file.go?source=/different/source")
	if suffix.Message != "file:<private-path>" || suffix.ID != suffixAlias.ID {
		t.Fatalf("file URI suffix aliases produced unstable blocker identities: %#v != %#v", suffix, suffixAlias)
	}
	directDrive := build(`C:\Work\Source`, "file:C:/Work/Source/file.go")
	directDriveAlias := build("c:/work/source", `file:c:\WORK\source/file.go`)
	if directDrive.ID != directDriveAlias.ID || directDrive.Message != directDriveAlias.Message {
		t.Fatalf("direct drive file URI aliases changed blocker identity: %#v != %#v", directDrive, directDriveAlias)
	}
	ambiguousDrive := build(`C:\Work\Source`, "file:////C:/Work/Source/file.go")
	ambiguousDriveAlias := build("c:/work/source", `FiLe:\\\\\c:\WORK\source\file.go`)
	if ambiguousDrive.Message != "file:<private-path>" || ambiguousDrive.ID != ambiguousDriveAlias.ID {
		t.Fatalf("ambiguous drive file URI aliases produced unstable blocker identities: %#v != %#v", ambiguousDrive, ambiguousDriveAlias)
	}
	invalidURI := build("/private/source", "file:///public/../\xff/private/source")
	invalidURIAlias := build("/different/source", "FiLe:///public/../\xfe/different/source")
	if invalidURI.Message != "file:<private-path>" || invalidURI.ID != invalidURIAlias.ID {
		t.Fatalf("invalid file URI aliases produced unstable blocker identities: %#v != %#v", invalidURI, invalidURIAlias)
	}
	traversalURI := build("/private/source", "file:///private/./source/file.go")
	traversalURIAlias := build("/different/source", "file:///public/../different/source/file.go")
	if traversalURI.Message != "file:<private-path>" || traversalURI.ID != traversalURIAlias.ID {
		t.Fatalf("traversal file URI aliases produced unstable blocker identities: %#v != %#v", traversalURI, traversalURIAlias)
	}
	malformedSuffix := build("/private/source", "file:///public/file.go?path=..")
	malformedSuffixAlias := build("/different/source", "file:///public/file.go?mode=read&&kind=x")
	if malformedSuffix.Message != "file:<private-path>" || malformedSuffix.ID != malformedSuffixAlias.ID {
		t.Fatalf("malformed file URI suffixes produced unstable blocker identities: %#v != %#v", malformedSuffix, malformedSuffixAlias)
	}
	malformedTail := build("/private/source", "file:///private source/file.go")
	malformedTailAlias := build("C:/Work/Source", "file:///public/C:/Work/Source/file.go")
	if malformedTail.Message != "file:<private-path>" || malformedTail.ID != malformedTailAlias.ID {
		t.Fatalf("malformed file URI tails produced unstable blocker identities: %#v != %#v", malformedTail, malformedTailAlias)
	}
	pathLocalhostDrive := build(`C:\Work\Source`, "file:/localhost/C:/Work/Source/file.go")
	pathLocalhostDriveAlias := build("c:/work/source", `FiLe:\\\LOCALHOST\c:\WORK\source\file.go`)
	if pathLocalhostDrive.Message != "file:<private-path>" ||
		pathLocalhostDrive.ID != pathLocalhostDriveAlias.ID {
		t.Fatalf("path-localhost drive aliases produced unstable blocker identities: %#v != %#v", pathLocalhostDrive, pathLocalhostDriveAlias)
	}
}

func TestProductionBlockerWritesUseCentralFinalization(t *testing.T) {
	if findings := productionBlockerWriteSites(t, "."); len(findings) != 0 {
		t.Fatalf("production blocker writes bypass central finalization: %v", findings)
	}

	for _, test := range []struct {
		name   string
		source string
	}{
		{
			name: "zero value direct append",
			source: `package main
func mutant(b *inventoryBuilder) {
	var blocker BlockerRecord
	appendInventoryRecord(b, &b.analysis.Blockers, blocker)
}`,
		},
		{
			name: "helper alias index assignment",
			source: `package main
func mutant(analysis *Analysis) {
	blockers := analysis.Blockers
	blockers[0].Message = "changed"
}`,
		},
		{
			name: "direct slice assignment",
			source: `package main
func mutant(analysis *Analysis) {
	analysis.Blockers = nil
}`,
		},
		{
			name: "central name collision",
			source: `package main
type rogue struct { analysis *Analysis }
func (r *rogue) finish() {
	r.analysis.Blockers = nil
}`,
		},
		{
			name: "shallow record copy mutation",
			source: `package main
func mutant(analysis *Analysis) {
	blocker := analysis.Blockers[0]
	blocker.AffectedUnits[0] = "changed"
}`,
		},
		{
			name: "range record copy mutation",
			source: `package main
func mutant(analysis *Analysis) {
	for _, blocker := range analysis.Blockers {
		blocker.DiagnosticIDs[0] = "changed"
	}
}`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "mutant.go"), []byte(test.source), 0o600); err != nil {
				t.Fatal(err)
			}
			if findings := productionBlockerWriteSites(t, root); len(findings) == 0 {
				t.Fatal("blocker write bypass was not detected")
			}
		})
	}
}

func productionBlockerWriteSites(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	var findings []string
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		path := filepath.Join(root, entry.Name())
		fileSet := token.NewFileSet()
		file, err := parser.ParseFile(fileSet, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			if isCentralBlockerFinalizer(entry.Name(), function) {
				continue
			}
			rangeAliases := blockerRangeAliases(function.Body)
			var stack []ast.Node
			ast.Inspect(function.Body, func(node ast.Node) bool {
				if node == nil {
					stack = stack[:len(stack)-1]
					return true
				}
				selector, ok := node.(*ast.SelectorExpr)
				if ok && selector.Sel.Name == "Blockers" &&
					blockerSelectorCanMutate(selector, stack) {
					line := fileSet.Position(selector.Pos()).Line
					findings = append(findings, fmt.Sprintf("%s:%s:%d", entry.Name(), function.Name.Name, line))
				}
				identifier, ok := node.(*ast.Ident)
				if ok && identifier.Obj != nil && rangeAliases[identifier.Obj] &&
					blockerRangeAliasCanMutate(identifier, stack) {
					line := fileSet.Position(identifier.Pos()).Line
					findings = append(findings, fmt.Sprintf("%s:%s:%d", entry.Name(), function.Name.Name, line))
				}
				stack = append(stack, node)
				return true
			})
		}
	}
	sort.Strings(findings)
	return findings
}

func blockerRangeAliases(body *ast.BlockStmt) map[*ast.Object]bool {
	aliases := map[*ast.Object]bool{}
	ast.Inspect(body, func(node ast.Node) bool {
		statement, ok := node.(*ast.RangeStmt)
		if !ok || !containsBlockersSelector(statement.X) {
			return true
		}
		identifier, ok := statement.Value.(*ast.Ident)
		if ok && identifier.Name != "_" && identifier.Obj != nil {
			aliases[identifier.Obj] = true
		}
		return true
	})
	return aliases
}

func containsBlockersSelector(node ast.Node) bool {
	found := false
	ast.Inspect(node, func(candidate ast.Node) bool {
		selector, ok := candidate.(*ast.SelectorExpr)
		if ok && selector.Sel.Name == "Blockers" {
			found = true
			return false
		}
		return !found
	})
	return found
}

func blockerRangeAliasCanMutate(identifier *ast.Ident, stack []ast.Node) bool {
	for index := len(stack) - 1; index >= 0; index-- {
		switch parent := stack[index].(type) {
		case *ast.UnaryExpr:
			if parent.Op == token.AND {
				return true
			}
		case *ast.AssignStmt:
			if expressionListContains(parent.Lhs, identifier) {
				return true
			}
			for _, expression := range parent.Rhs {
				if expression == identifier {
					return true
				}
			}
			return false
		case *ast.IncDecStmt:
			return astNodeContains(parent.X, identifier)
		case *ast.CallExpr:
			for _, argument := range parent.Args {
				if argument == identifier {
					return true
				}
			}
			return false
		case *ast.ReturnStmt:
			return true
		case *ast.RangeStmt:
			if parent.Value == identifier {
				return false
			}
		}
	}
	return false
}

func isCentralBlockerFinalizer(filename string, function *ast.FuncDecl) bool {
	if filename != "inventory.go" {
		return false
	}
	if function.Name.Name == "normalizeAnalysisCollections" {
		return function.Recv == nil
	}
	if function.Name.Name != "addBlocker" && function.Name.Name != "finish" ||
		function.Recv == nil || len(function.Recv.List) != 1 {
		return false
	}
	receiver := function.Recv.List[0].Type
	if pointer, ok := receiver.(*ast.StarExpr); ok {
		receiver = pointer.X
	}
	identifier, ok := receiver.(*ast.Ident)
	return ok && identifier.Name == "inventoryBuilder"
}

func blockerSelectorCanMutate(selector *ast.SelectorExpr, stack []ast.Node) bool {
	for index := len(stack) - 1; index >= 0; index-- {
		switch parent := stack[index].(type) {
		case *ast.UnaryExpr:
			if parent.Op == token.AND {
				return true
			}
		case *ast.AssignStmt:
			if expressionListContains(parent.Lhs, selector) {
				return true
			}
			for _, expression := range parent.Rhs {
				if blockerAliasExpression(expression, selector) {
					return true
				}
			}
			return false
		case *ast.IncDecStmt:
			return astNodeContains(parent.X, selector)
		case *ast.CallExpr:
			if readOnlyBlockerCall(parent) {
				return false
			}
			for _, argument := range parent.Args {
				if astNodeContains(argument, selector) {
					return true
				}
			}
		case *ast.ReturnStmt:
			return true
		}
	}
	return false
}

func blockerAliasExpression(expression ast.Expr, selector *ast.SelectorExpr) bool {
	for {
		if expression == selector {
			return true
		}
		switch value := expression.(type) {
		case *ast.ParenExpr:
			expression = value.X
		case *ast.SliceExpr:
			return astNodeContains(value.X, selector)
		case *ast.IndexExpr:
			return astNodeContains(value.X, selector)
		case *ast.SelectorExpr:
			return (value.Sel.Name == "AffectedUnits" || value.Sel.Name == "DiagnosticIDs") &&
				astNodeContains(value.X, selector)
		default:
			return false
		}
	}
}

func expressionListContains(expressions []ast.Expr, target ast.Node) bool {
	for _, expression := range expressions {
		if astNodeContains(expression, target) {
			return true
		}
	}
	return false
}

func astNodeContains(root, target ast.Node) bool {
	found := false
	ast.Inspect(root, func(node ast.Node) bool {
		if node == target {
			found = true
			return false
		}
		return !found
	})
	return found
}

func readOnlyBlockerCall(call *ast.CallExpr) bool {
	if identifier, ok := call.Fun.(*ast.Ident); ok {
		return identifier.Name == "len" || identifier.Name == "cap"
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	packageName, packageOK := selector.X.(*ast.Ident)
	return ok && packageOK && packageName.Name == "slices" && selector.Sel.Name == "ContainsFunc"
}

func assertPublishedBlocker(t *testing.T, blocker BlockerRecord, max int) {
	t.Helper()
	if !utf8.ValidString(blocker.Message) || len(blocker.Message) == 0 || len(blocker.Message) > max {
		t.Fatalf("published blocker message is invalid or too large: %q", blocker.Message)
	}
	units := append([]string{}, blocker.AffectedUnits...)
	sort.Strings(units)
	wantID := stableID("blocker",
		blocker.Blocks+"\x00"+blocker.Category+"\x00"+blocker.Message+"\x00"+strings.Join(units, "\x00"))
	if blocker.ID != wantID {
		t.Fatalf("blocker ID = %q; want %q for published message %q", blocker.ID, wantID, blocker.Message)
	}
	data, err := json.Marshal(blocker)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip BlockerRecord
	if err := json.Unmarshal(data, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.Message != blocker.Message || roundTrip.ID != blocker.ID ||
		!utf8.ValidString(roundTrip.Message) || len(roundTrip.Message) > max {
		t.Fatalf("blocker JSON round trip changed bounded identity: %#v", roundTrip)
	}
}
