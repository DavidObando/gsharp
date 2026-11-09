// <copyright file="WaikikiHoverAuditTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import Nerdbank.Streams
import StreamJsonRpc
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Security.Cryptography
import System.Text
import System.Text.Json
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #5026: portable headless hover regression audit over Waikiki and deterministic PR fixtures.
/// The harness shares one syntax/semantic inventory and compiler-symbol oracle across fast PR tests
/// and the scheduled/manual SHA-pinned Waikiki sweep (`ec66d0bfaa39583cd11c66095f2748342dc9e8f6`).
open class WaikikiHoverAuditTests {
    @Fact
    func ReviewedExpectations_AreCompleteAndIssueLinked() {
        Assert.Empty(ReviewedFailures)
        Assert.Empty(ReviewedSyntaxGaps)
        Assert.Empty(ReviewedDidOpenRepointGaps)
        let seenFailureTargets = HashSet[string](StringComparer.Ordinal)
        for item in ReviewedFailures {
            Assert.False(string.IsNullOrWhiteSpace(item.TargetId))
            Assert.True(seenFailureTargets.Add(item.TargetId), "Duplicate reviewed failure target: ${item.TargetId}")
            Assert.StartsWith("#", item.Issue, StringComparison.Ordinal)
            Assert.False(string.IsNullOrWhiteSpace(item.Kind))
            Assert.False(string.IsNullOrWhiteSpace(item.Expected))
            Assert.False(string.IsNullOrWhiteSpace(item.Actual))
            Assert.DoesNotContain("\\", item.TargetId, StringComparison.Ordinal)
        }
        let seenGapTargets = HashSet[string](StringComparer.Ordinal)
        for gap in ReviewedSyntaxGaps.Concat(ReviewedDidOpenRepointGaps) {
            Assert.False(string.IsNullOrWhiteSpace(gap))
            Assert.True(seenGapTargets.Add(gap), "Duplicate reviewed syntax gap: $gap")
            Assert.Contains("|", gap, StringComparison.Ordinal)
            Assert.DoesNotContain("\\", gap, StringComparison.Ordinal)
        }
    }

    @Fact
    async func SmallCorpus_EndToEndHeadlessAudit_And_MutantWitnesses() {
        let scratchRoot = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "hover-audit-small-" + Guid.NewGuid().ToString("N")
        )
        let corpusRoot = Path.Combine(scratchRoot, "corpus")
        let artifactsDir = Path.Combine(scratchRoot, "artifacts")
        Directory.CreateDirectory(corpusRoot)
        Directory.CreateDirectory(artifactsDir)
        try {
            WriteSmallDeterministicCorpus(corpusRoot)
            let summary = await RunWorkspaceAuditAsync(
                corpusRoot,
                artifactsDir,
                corpusCommit: "in-repo-small-corpus",
                enforceWaikikiBaseline: false
            )
            Assert.Equal(1, summary.ProjectCount)
            Assert.Equal(2, summary.AuthoredFileCount)
            Assert.Equal(1, summary.GeneratedFileCount)
            Assert.True(summary.PhysicalTokenCount > 150)
            Assert.True(summary.StartAndInteriorCheckCount > summary.PhysicalTokenCount)
            Assert.True(summary.CompilerOracleTargetCount > 50)
            Assert.Equal(0, summary.PlaceholderHoverCount)
            Assert.Equal(0, summary.SyntheticLeakCount)
            Assert.Equal(0, summary.InteriorMismatchCount)
            Assert.True(
                summary.UnreviewedFailureCount == 0,
                File.ReadAllText(Path.Combine(artifactsDir, "failures.csv"))
            )
            Assert.Equal(0, summary.StaleExpectationCount)

            for fileName in[]string{"summary.json", "summary.md", "failures.json", "failures.csv", "inventory.json"} {
                let artifactPath = Path.Combine(artifactsDir, fileName)
                Assert.True(File.Exists(artifactPath), "Missing artifact: $fileName")
                let text = File.ReadAllText(artifactPath)
                Assert.DoesNotContain(corpusRoot, text, StringComparison.OrdinalIgnoreCase)
                Assert.DoesNotContain("ACCESS-SECRET", text, StringComparison.Ordinal)
            }

            // Verify indexed-member inventory collects accessor-nested indexed targets (runner.Calls[0],
            // call.Args[0], call.FileName[0], uri.ToString()[0], etc.) while excluding bare indexed
            // locals and index-argument identifiers.
            let consumerPath = Path.Combine(corpusRoot, "Consumer.gs")
            let consumerText = File.ReadAllText(consumerPath)
            let consumerTree = SyntaxTree.Parse(SourceText.From(consumerText, consumerPath))
            let indexedSpans = CollectIndexedMemberTokenSpans(consumerTree.Root)
            let indexedRoles = List[string]()
            for tok in EnumerateTreeTokens(consumerTree.Root) {
                if IsPhysicalToken(consumerTree.Text, tok) && tok.Kind == SyntaxKind.IdentifierToken {
                    let role = ClassifyTokenRole(tok, indexedSpans)
                    if role == "IndexedMemberAccess" {
                        let line1 = SemanticLookup.ToRange(consumerTree.Text, tok.Span).Start.Line + 1
                        indexedRoles.Add("$line1:${tok.Text}")
                    }
                }
            }
            let expectedIndexedLines = []string{
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Calls[0]", 0).Line + 1}:Calls",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Calls[^1]", 0).Line + 1}:Calls",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Args[0]", 0).Line + 1}:Args",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Args[..]", 0).Line + 1}:Args",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "FileName[0]", 0).Line + 1}:FileName",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "FileName[1..^1]", 0).Line + 1}:FileName",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Calls[0].FileName.Length", 0).Line + 1}:Calls",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Segments[0]", 0).Line + 1}:Segments",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Host[0]", 0).Line + 1}:Host",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "ToString()[0]", 0).Line + 1}:ToString",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Calls[Calls]", 0).Line + 1}:Calls",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Args[Args]", 0).Line + 1}:Args",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Calls[^1]", 1).Line + 1}:Calls",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Span[0]", 0).Line + 1}:Span",
                "${LanguageServerTestHelpers.PositionOf(consumerText, "Span[0]", 1).Line + 1}:Span"
            }
            Assert.Equal(expectedIndexedLines, indexedRoles)

            let bareLocalOffset = consumerText.IndexOf("plainArgs[0]", StringComparison.Ordinal)
            let bareLocalTok = SemanticLookup.FindTokenAt(consumerTree, bareLocalOffset)!!
            Assert.Equal("NameExpression", ClassifyTokenRole(bareLocalTok, indexedSpans))

            let indexArgOffset = consumerText.IndexOf("Calls]", StringComparison.Ordinal)
            let indexArgTok = SemanticLookup.FindTokenAt(consumerTree, indexArgOffset)!!
            Assert.Equal("NameExpression", ClassifyTokenRole(indexArgTok, indexedSpans))

            // Verify wrong-member navigation in the same file fails the declaration range check.
            let modelsUri = DocumentUri.FromFileSystemPath(Path.Combine(corpusRoot, "Models.gs"))!!
            let expectedCallsLoc = Location{
                Uri: modelsUri,
                Range: GSharp.LanguageServer.Protocol.Range(Position(58, 9), Position(58, 14))
            }
            let wrongSameFileLoc = Location{
                Uri: modelsUri,
                Range: GSharp.LanguageServer.Protocol.Range(Position(43, 9), Position(43, 13))
            }
            Assert.True(LocationsMatchExpectedDeclaration(expectedCallsLoc, expectedCallsLoc))
            Assert.False(LocationsMatchExpectedDeclaration(expectedCallsLoc, wrongSameFileLoc))

            // Verify configured GSHARP_WAIKIKI_CORPUS_ROOT opts out only when absent/whitespace
            // and fails explicitly when pointing to a nonexistent directory.
            Assert.Null(ResolveConfiguredWaikikiCorpusRoot(nil))
            Assert.Null(ResolveConfiguredWaikikiCorpusRoot("   "))
            Assert.Equal(corpusRoot, ResolveConfiguredWaikikiCorpusRoot(corpusRoot))
            let missingCorpusPath = Path.Combine(scratchRoot, "missing-waikiki-corpus")
            let missingCorpusEx = Assert.Throws[Xunit.Sdk.TrueException](
                () -> {
                    let _ = ResolveConfiguredWaikikiCorpusRoot(missingCorpusPath)
                }
            )
            Assert.Contains(missingCorpusPath, missingCorpusEx.Message, StringComparison.Ordinal)

            // Verify IsSyntheticTokenHitLeak flags non-physical keyword/punctuation tokens with positive width (#5277).
            let syntheticKeywordTree = SyntaxTree.Parse("return {")
            let syntheticKeywordTokens = SyntaxTree.ParseTokens(syntheticKeywordTree.Text).ToList()
            let syntheticReturnToken = syntheticKeywordTokens.First(
                (t SyntaxToken) -> t.Kind == SyntaxKind.ReturnKeyword
            )
            let syntheticBraceToken = syntheticKeywordTokens.First(
                (t SyntaxToken) -> t.Kind == SyntaxKind.OpenBraceToken
            )
            Assert.True(syntheticReturnToken.Span.Length > 0)
            Assert.True(syntheticBraceToken.Span.Length > 0)
            Assert.True(IsSyntheticTokenHitLeak(consumerTree.Text, syntheticReturnToken))
            Assert.True(IsSyntheticTokenHitLeak(consumerTree.Text, syntheticBraceToken))
            Assert.False(IsSyntheticTokenHitLeak(consumerTree.Text, bareLocalTok))

            // ADR-0154 discrimination witnesses: verify each failure class fails the gate.
            let mutantPlaceholder = EvaluateTargetCheck(
                "Consumer.gs:24:13:loaded",
                "VariableDeclaration",
                "(local variable) loaded AuditSample.TokenSet?",
                "(local variable) loaded ?",
                rangeMatches: true,
                interiorMatches: true,
                definitionMatches: true,
                Array.Empty[ReviewedFailure](),
                HashSet[string](StringComparer.Ordinal)
            )
            Assert.Equal("PlaceholderType", mutantPlaceholder?.Kind)
            Assert.True(mutantPlaceholder?.IsUnreviewed == true)

            let mutantMissingLocal = EvaluateTargetCheck(
                "Consumer.gs:24:13:loaded",
                "VariableDeclaration",
                "(local variable) loaded AuditSample.TokenSet?",
                "",
                rangeMatches: true,
                interiorMatches: true,
                definitionMatches: true,
                Array.Empty[ReviewedFailure](),
                HashSet[string](StringComparer.Ordinal)
            )
            Assert.Equal("MissingCompilerSymbolHover", mutantMissingLocal?.Kind)
            Assert.True(mutantMissingLocal?.IsUnreviewed == true)

            let mutantWrongMethod = EvaluateTargetCheck(
                "Consumer.gs:32:29:ToString",
                "MemberAccess",
                "func (System.Uri) ToString() string",
                "func (System.Text.Json.Nodes.JsonNode) ToString() string",
                rangeMatches: true,
                interiorMatches: true,
                definitionMatches: true,
                Array.Empty[ReviewedFailure](),
                HashSet[string](StringComparer.Ordinal)
            )
            Assert.Equal("SignatureMismatch", mutantWrongMethod?.Kind)
            Assert.True(mutantWrongMethod?.IsUnreviewed == true)

            let mutantMissingDefinition = EvaluateTargetCheck(
                "Consumer.gs:27:27:Calls",
                "IndexedMemberAccess",
                "prop Calls System.Collections.Generic.List[AuditSample.RunnerCall] { get; }",
                "prop Calls System.Collections.Generic.List[AuditSample.RunnerCall] { get; }",
                rangeMatches: true,
                interiorMatches: true,
                definitionMatches: false,
                Array.Empty[ReviewedFailure](),
                HashSet[string](StringComparer.Ordinal)
            )
            Assert.Equal("MissingSourceDefinition", mutantMissingDefinition?.Kind)
            Assert.True(mutantMissingDefinition?.IsUnreviewed == true)

            let nonOracleInteriorFailures = List[AuditFailureRecord]()
            let nonOracleHover = Hover{
                Contents: MarkedStringsOrMarkupContent(
                    MarkupContent{Kind: MarkupKind.Markdown, Value: "```gsharp\nstring\n```"}
                ),
                Range: GSharp.LanguageServer.Protocol.Range(Position(48, 15), Position(48, 25))
            }
            RecordInteriorMismatchIfUnrecorded(
                "Consumer.gs:49:16:\"generated\"",
                "LiteralExpressionSyntax",
                nonOracleHover,
                nil,
                interiorMatches: false,
                alreadyRecorded: false,
                Array.Empty[ReviewedFailure](),
                HashSet[string](StringComparer.Ordinal),
                nonOracleInteriorFailures
            )
            let recordedNonOracle = Assert.Single(nonOracleInteriorFailures)
            Assert.Equal("InteriorHoverMismatch", recordedNonOracle.Kind)
            Assert.True(recordedNonOracle.IsUnreviewed)

            RecordInteriorMismatchIfUnrecorded(
                "Consumer.gs:27:27:Calls",
                "IndexedMemberAccess",
                nonOracleHover,
                nil,
                interiorMatches: false,
                alreadyRecorded: true,
                Array.Empty[ReviewedFailure](),
                HashSet[string](StringComparer.Ordinal),
                nonOracleInteriorFailures
            )
            Assert.Single(nonOracleInteriorFailures)

            let nonOraclePlaceholderFailures = List[AuditFailureRecord]()
            RecordPlaceholderHoverIfUnrecorded(
                "Consumer.gs:24:13:loaded",
                "NameExpression",
                "(local variable) loaded ?",
                isPlaceholderHover: true,
                alreadyRecorded: false,
                Array.Empty[ReviewedFailure](),
                HashSet[string](StringComparer.Ordinal),
                nonOraclePlaceholderFailures
            )
            let recordedPlaceholder = Assert.Single(nonOraclePlaceholderFailures)
            Assert.Equal("PlaceholderType", recordedPlaceholder.Kind)
            Assert.True(recordedPlaceholder.IsUnreviewed)

            RecordPlaceholderHoverIfUnrecorded(
                "Consumer.gs:24:13:loaded",
                "NameExpression",
                "(local variable) loaded ?",
                isPlaceholderHover: true,
                alreadyRecorded: true,
                Array.Empty[ReviewedFailure](),
                HashSet[string](StringComparer.Ordinal),
                nonOraclePlaceholderFailures
            )
            Assert.Single(nonOraclePlaceholderFailures)

            let matchedReviewed = HashSet[string](StringComparer.Ordinal)
            let passingWithStaleExpectation = EvaluateTargetCheck(
                "Consumer.gs:32:29:ToString",
                "MemberAccess",
                "func (System.Uri) ToString() string",
                "func (System.Uri) ToString() string",
                rangeMatches: true,
                interiorMatches: true,
                definitionMatches: true,
                []ReviewedFailure{
                    ReviewedFailure(
                        "Consumer.gs:32:29:ToString",
                        "#5035",
                        "SignatureMismatch",
                        "func (System.Uri) ToString() string",
                        "func (System.Text.Json.Nodes.JsonNode) ToString() string"
                    )
                },
                matchedReviewed
            )
            Assert.Null(passingWithStaleExpectation)
            Assert.Empty(matchedReviewed)
        } finally {
            if Directory.Exists(scratchRoot) {
                Directory.Delete(scratchRoot, recursive: true)
            }
        }
    }

    @Fact
    async func Lifecycle_ColdOpen_Restart_Reopen_BodyEdits_WindowsUri_And_FullRebindControl() {
        let scratchRoot = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "hover-audit-lifecycle-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(scratchRoot)
        try {
            WriteSmallDeterministicCorpus(scratchRoot)
            await VerifyLifecyclePhasesOverRpcAsync(
                scratchRoot,
                Path.Combine(scratchRoot, "Consumer.gs"),
                Path.Combine(scratchRoot, "Models.gs"),
                localSymbolName: "loaded",
                expectedLocalHover: "(local variable) loaded TokenSet?",
                guardSymbolName: "s",
                expectedGuardHover: "(local variable) s ITokenStore?",
                expectedGuardCallHover: "func (ITokenStore) LoadAsync() System.Threading.Tasks.Task[TokenSet?]",
                indexedPropName: "Calls",
                expectedIndexedPropHover: "prop Calls System.Collections.Generic.List[RunnerCall] { get; }",
                indexedArrayPropName: "Args",
                expectedIndexedArrayPropHover: "prop Args []string { get; set; }"
            )
        } finally {
            if Directory.Exists(scratchRoot) {
                Directory.Delete(scratchRoot, recursive: true)
            }
        }
    }

    @Fact
    func IndexedMember_And_ReceiverProvenance_Matrix() {
        let scratchRoot = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "hover-audit-indexed-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(scratchRoot)
        try {
            WriteSmallDeterministicCorpus(scratchRoot)
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, scratchRoot, waitForWarmUp: true)
            let project = Assert.Single(workspace.Projects)
            let compilation = project.GetCompilation()
            Assert.Empty(compilation.GetDiagnostics().Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))

            let consumerPath = Path.Combine(scratchRoot, "Consumer.gs")
            let modelsPath = Path.Combine(scratchRoot, "Models.gs")
            let consumerText = File.ReadAllText(consumerPath)
            let modelsText = File.ReadAllText(modelsPath)
            Assert.True(project.TryGetSyntaxTree(consumerPath, out var consumerTree))
            let lines = BuildLineOffsets(consumerText)
            let content = DocumentContent(consumerTree, lines, project, workspace)
            let consumerUri = DocumentUri.FromFileSystemPath(consumerPath)!!
            let modelsUri = DocumentUri.FromFileSystemPath(modelsPath)!!

            // 1. runner.Calls vs runner.Calls[0] vs runner.Calls[^1]
            let plainCallsHover = AssertHoverAt(
                content,
                consumerText,
                "Calls\n",
                0,
                "Calls",
                "prop Calls System.Collections.Generic.List[RunnerCall] { get; }"
            )
            let indexedCallsHover = AssertHoverAt(
                content,
                consumerText,
                "Calls[0]",
                0,
                "Calls",
                "prop Calls System.Collections.Generic.List[RunnerCall] { get; }"
            )
            let fromEndCallsHover = AssertHoverAt(
                content,
                consumerText,
                "Calls[^1]",
                0,
                "Calls",
                "prop Calls System.Collections.Generic.List[RunnerCall] { get; }"
            )
            Assert.Equal(plainCallsHover.Contents.ToString(), indexedCallsHover.Contents.ToString())
            Assert.Equal(plainCallsHover.Contents.ToString(), fromEndCallsHover.Contents.ToString())
            let callsDeclPos = LanguageServerTestHelpers.PositionOf(modelsText, "Calls List[RunnerCall]", 0)
            let expectedCallsDeclLoc = Location{
                Uri: modelsUri,
                Range: GSharp
                    .LanguageServer
                    .Protocol
                    .Range(callsDeclPos, Position(callsDeclPos.Line, callsDeclPos.Character + "Calls".Length))
            }
            let callsDef = Assert.IsType[Location](
                DefinitionComputer.ComputeDefinition(
                    consumerUri,
                    content,
                    LanguageServerTestHelpers.PositionOf(consumerText, "Calls[0]", 0)
                )
            )
            Assert.True(LocationsMatchExpectedDeclaration(expectedCallsDeclLoc, callsDef))

            // 2. call.Args vs call.Args[0] vs call.Args[..]
            let plainArgsHover = AssertHoverAt(
                content,
                consumerText,
                "Args\n",
                0,
                "Args",
                "prop Args []string { get; set; }"
            )
            let indexedArgsHover = AssertHoverAt(
                content,
                consumerText,
                "Args[0]",
                0,
                "Args",
                "prop Args []string { get; set; }"
            )
            let sliceArgsHover = AssertHoverAt(
                content,
                consumerText,
                "Args[..]",
                0,
                "Args",
                "prop Args []string { get; set; }"
            )
            Assert.Equal(plainArgsHover.Contents.ToString(), indexedArgsHover.Contents.ToString())
            Assert.Equal(plainArgsHover.Contents.ToString(), sliceArgsHover.Contents.ToString())
            let argsDeclPos = LanguageServerTestHelpers.PositionOf(modelsText, "Args []string", 0)
            let expectedArgsDeclLoc = Location{
                Uri: modelsUri,
                Range: GSharp
                    .LanguageServer
                    .Protocol
                    .Range(argsDeclPos, Position(argsDeclPos.Line, argsDeclPos.Character + "Args".Length))
            }
            let argsDef = Assert.IsType[Location](
                DefinitionComputer.ComputeDefinition(
                    consumerUri,
                    content,
                    LanguageServerTestHelpers.PositionOf(consumerText, "Args[0]", 0)
                )
            )
            Assert.True(LocationsMatchExpectedDeclaration(expectedArgsDeclLoc, argsDef))

            // 3. call.FileName vs call.FileName[0] vs call.FileName[1..^1]
            let plainFileHover = AssertHoverAt(
                content,
                consumerText,
                "FileName\n",
                0,
                "FileName",
                "prop FileName string { get; set; }"
            )
            let indexedFileHover = AssertHoverAt(
                content,
                consumerText,
                "FileName[0]",
                0,
                "FileName",
                "prop FileName string { get; set; }"
            )
            let sliceFileHover = AssertHoverAt(
                content,
                consumerText,
                "FileName[1..^1]",
                0,
                "FileName",
                "prop FileName string { get; set; }"
            )
            Assert.Equal(plainFileHover.Contents.ToString(), indexedFileHover.Contents.ToString())
            Assert.Equal(plainFileHover.Contents.ToString(), sliceFileHover.Contents.ToString())
            let fileDeclPos = LanguageServerTestHelpers.PositionOf(modelsText, "FileName string", 0)
            let expectedFileDeclLoc = Location{
                Uri: modelsUri,
                Range: GSharp
                    .LanguageServer
                    .Protocol
                    .Range(fileDeclPos, Position(fileDeclPos.Line, fileDeclPos.Character + "FileName".Length))
            }
            let fileDef = Assert.IsType[Location](
                DefinitionComputer.ComputeDefinition(
                    consumerUri,
                    content,
                    LanguageServerTestHelpers.PositionOf(consumerText, "FileName[0]", 0)
                )
            )
            Assert.True(LocationsMatchExpectedDeclaration(expectedFileDeclLoc, fileDef))

            // 4. uri.Segments / uri.Host, plain and indexed
            AssertHoverAt(content, consumerText, "Segments\n", 0, "Segments", "System.Uri.Segments []string { get; }")
            AssertHoverAt(content, consumerText, "Segments[0]", 0, "Segments", "System.Uri.Segments []string { get; }")
            AssertHoverAt(content, consumerText, "Host\n", 0, "Host", "System.Uri.Host string { get; }")
            AssertHoverAt(content, consumerText, "Host[0]", 0, "Host", "System.Uri.Host string { get; }")

            // 5. runner.Calls[0].FileName.Length — verify every segment in the chain
            AssertHoverAt(
                content,
                consumerText,
                "Calls[0].FileName.Length",
                0,
                "Calls",
                "prop Calls System.Collections.Generic.List[RunnerCall] { get; }"
            )
            AssertHoverAt(content, consumerText, "FileName.Length", 0, "FileName", "prop FileName string { get; set; }")
            AssertHoverAt(content, consumerText, "Length\n", 0, "Length", "string.Length int32 { get; }")

            // 6. uri.ToString() vs uri.ToString()[0] with competing JsonNode.ToString()
            AssertHoverAt(content, consumerText, "ToString()\n", 1, "ToString", "func (System.Uri) ToString() string")
            let indexedUriToString = AssertHoverAt(
                content,
                consumerText,
                "ToString()[0]",
                0,
                "ToString",
                "func (System.Uri) ToString() string"
            )
            Assert.DoesNotContain("JsonNode", indexedUriToString.Contents.ToString(), StringComparison.Ordinal)

            // 7. Index-argument locals that collide with member and global names
            AssertHoverAt(content, consumerText, "Calls]", 0, "Calls", "(local variable) Calls int32")
            AssertHoverAt(content, consumerText, "Args]", 0, "Args", "(local variable) Args int32")
            let indexLocalDef = Assert.IsType[Location](
                DefinitionComputer.ComputeDefinition(
                    consumerUri,
                    content,
                    LanguageServerTestHelpers.PositionOf(consumerText, "Calls]", 0)
                )
            )
            Assert.Equal(consumerUri, indexLocalDef.Uri)
            Assert.Equal(
                LanguageServerTestHelpers.PositionOf(consumerText, "Calls = 0", 0).Line,
                indexLocalDef.Range.Start.Line
            )

            // 8. Null-conditional indexed targets and ref-returning CLR Span[0]
            AssertHoverAt(
                content,
                consumerText,
                "Calls[^1]",
                1,
                "Calls",
                "prop Calls System.Collections.Generic.List[RunnerCall] { get; }"
            )
            AssertHoverAt(
                content,
                consumerText,
                "Span[0]",
                0,
                "Span",
                "System.Memory[int32].Span System.Span[int32] { get; }"
            )
            AssertHoverAt(
                content,
                consumerText,
                "Span[0]",
                1,
                "Span",
                "System.ReadOnlyMemory[int32].Span System.ReadOnlySpan[int32] { get; }"
            )
        } finally {
            if Directory.Exists(scratchRoot) {
                Directory.Delete(scratchRoot, recursive: true)
            }
        }
    }

    @Fact
    async func StdioProcess_HeadlessHandshake_Hover_Cancel_And_CleanShutdown() {
        let scratchRoot = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "hover-audit-stdio-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(scratchRoot)
        var process Process? = nil
        try {
            WriteSmallDeterministicCorpus(scratchRoot)
            let serverDll = LocateLanguageServerDll()
            let startInfo = ProcessStartInfo("dotnet")
            startInfo.UseShellExecute = false
            startInfo.RedirectStandardInput = true
            startInfo.RedirectStandardOutput = true
            startInfo.RedirectStandardError = true
            startInfo.CreateNoWindow = true
            startInfo.WorkingDirectory = scratchRoot
            startInfo.ArgumentList.Add(serverDll)
            let startedProcess = Process.Start(startInfo)!!
            process = startedProcess

            let stdin = startedProcess.StandardInput.BaseStream
            let stdout = startedProcess.StandardOutput.BaseStream
            let rootUri = DocumentUri.FromFileSystemPath(scratchRoot)!!.ToString()
            let consumerPath = Path.Combine(scratchRoot, "Consumer.gs")
            let consumerText = File.ReadAllText(consumerPath)
            let consumerUri = DocumentUri.FromFileSystemPath(consumerPath)!!.ToString()

            await WriteLspFrameAsync(
                stdin,
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"rootPath\":${JsonSerializer.Serialize(scratchRoot)},\"rootUri\":${JsonSerializer.Serialize(rootUri)},\"capabilities\":{\"textDocument\":{\"diagnostic\":{}},\"workspace\":{\"diagnostics\":{\"refreshSupport\":true}}}}}"
            )
            let initReply = await ReadLspResponseForIdAsync(stdout, 1, TimeSpan.FromSeconds(30))
            Assert.Contains("\"hoverProvider\":true", initReply, StringComparison.Ordinal)

            await WriteLspFrameAsync(stdin, "{\"jsonrpc\":\"2.0\",\"method\":\"initialized\",\"params\":{}}")
            let didOpenJson = JsonSerializer.Serialize(
                DidOpenTextDocumentParams{
                    TextDocument: TextDocumentItem{
                        Uri: DocumentUri.FromFileSystemPath(consumerPath)!!,
                        LanguageId: "gsharp",
                        Version: 1,
                        Text: consumerText
                    }
                },
                LspJson.Options
            )
            await WriteLspFrameAsync(
                stdin,
                "{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/didOpen\",\"params\":$didOpenJson}"
            )
            await WriteLspFrameAsync(
                stdin,
                "{\"jsonrpc\":\"2.0\",\"method\":\"$/cancelRequest\",\"params\":{\"id\":999}}"
            )

            let pos = LanguageServerTestHelpers.PositionOf(consumerText, "Calls[0]", 0)
            await WriteLspFrameAsync(
                stdin,
                "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"textDocument/hover\",\"params\":{\"textDocument\":{\"uri\":${JsonSerializer.Serialize(consumerUri)}},\"position\":{\"line\":${pos.Line},\"character\":${pos.Character}}}}"
            )
            let hoverReply = await ReadLspResponseForIdAsync(stdout, 2, TimeSpan.FromSeconds(30))
            Assert.Contains(
                "prop Calls System.Collections.Generic.List[RunnerCall]",
                hoverReply,
                StringComparison.Ordinal
            )

            await WriteLspFrameAsync(stdin, "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"shutdown\",\"params\":null}")
            let shutdownReply = await ReadLspResponseForIdAsync(stdout, 3, TimeSpan.FromSeconds(15))
            Assert.Contains("\"result\":null", shutdownReply, StringComparison.Ordinal)

            await WriteLspFrameAsync(stdin, "{\"jsonrpc\":\"2.0\",\"method\":\"exit\",\"params\":null}")
            using let cts = CancellationTokenSource(TimeSpan.FromSeconds(15))
            await startedProcess.WaitForExitAsync(cts.Token)
            Assert.Equal(0, startedProcess.ExitCode)
        } finally {
            if let running = process {
                try {
                    if !running.HasExited {
                        try {
                            running.Kill(entireProcessTree: true)
                        } catch (InvalidOperationException) { }
                        using let killWaitCts = CancellationTokenSource(TimeSpan.FromSeconds(15))
                        await running.WaitForExitAsync(killWaitCts.Token)
                    }
                } finally {
                    running.Dispose()
                }
            }
            if Directory.Exists(scratchRoot) {
                Directory.Delete(scratchRoot, recursive: true)
            }
        }
    }

    @Fact
    async func PinnedWaikikiCorpus_FullHeadlessAudit() {
        guard let corpusRoot = ResolveConfiguredWaikikiCorpusRoot(
            Environment.GetEnvironmentVariable("GSHARP_WAIKIKI_CORPUS_ROOT")
        ) else {
            return
        }
        let explicitOut = Environment.GetEnvironmentVariable("GSHARP_WAIKIKI_AUDIT_OUT")
        let artifactsDir = if !string.IsNullOrWhiteSpace(explicitOut) {
            explicitOut!!
        } else {
            Path.Combine(Directory.GetCurrentDirectory(), "out", "waikiki-hover-audit-" + Guid.NewGuid().ToString("N"))
        }
        Directory.CreateDirectory(artifactsDir)
        try {
            let tokenStoreTestsPath = Path.Combine(corpusRoot, "tests", "Waikiki.Core.Tests", "TokenStoreTests.gs")
            let fakeRunnerPath = Path.Combine(corpusRoot, "tests", "Waikiki.Core.Tests", "FakeRunner.gs")
            Assert.True(File.Exists(tokenStoreTestsPath), "Missing TokenStoreTests.gs in Waikiki corpus.")
            Assert.True(File.Exists(fakeRunnerPath), "Missing FakeRunner.gs in Waikiki corpus.")
            let initialBytes = File.ReadAllBytes(tokenStoreTestsPath)
            let normalizedLfBytes = Encoding.UTF8.GetBytes(
                Encoding.UTF8.GetString(initialBytes).Replace("\r\n", "\n", StringComparison.Ordinal)
            )
            let lfSha256 = Convert.ToHexString(SHA256.HashData(normalizedLfBytes)).ToLowerInvariant()
            Assert.Equal("cf1a6e2f3bbaa2cb2558b6f85b4b410853ff33de6f932d9c27438bd166e175fc", lfSha256)

            await VerifyLifecyclePhasesOverRpcAsync(
                corpusRoot,
                tokenStoreTestsPath,
                fakeRunnerPath,
                localSymbolName: "loaded",
                expectedLocalHover: "(local variable) loaded Waikiki.Yoto.TokenSet?",
                guardSymbolName: "s",
                expectedGuardHover: "(local variable) s Waikiki.Yoto.ITokenStore?",
                expectedGuardCallHover: "func (Waikiki.Yoto.ITokenStore) LoadAsync() System.Threading.Tasks.Task[Waikiki.Yoto.TokenSet]",
                indexedPropName: "Calls",
                expectedIndexedPropHover: "prop Calls System.Collections.Generic.List[RunnerCall] { get; set; }",
                indexedArrayPropName: "Args",
                expectedIndexedArrayPropHover: "prop Args []string { get; set; }"
            )
            Assert.Equal(initialBytes, File.ReadAllBytes(tokenStoreTestsPath))

            let summary = await RunWorkspaceAuditAsync(
                corpusRoot,
                artifactsDir,
                corpusCommit: PinnedWaikikiCommit,
                enforceWaikikiBaseline: true
            )
            Assert.Equal(8, summary.ProjectCount)
            Assert.Equal(68, summary.AuthoredFileCount)
            Assert.Equal(13, summary.GeneratedFileCount)
            Assert.Equal(45829, summary.PhysicalTokenCount)
            Assert.Equal(68039, summary.StartAndInteriorCheckCount)
            Assert.Equal(602, summary.ExcludedSyntheticTokenCount)
            Assert.Equal(0, summary.SyntheticLeakCount)
            Assert.Equal(0, summary.PlaceholderHoverCount)
            Assert.Equal(0, summary.InteriorMismatchCount)
            Assert.Equal(11056, summary.CompilerOracleTargetCount)
            Assert.Equal(11056, summary.CompilerOracleMatchedCount)
            Assert.Equal(0, summary.ReviewedFailureCount)
            Assert.Equal(0, summary.ReviewedSyntaxGapCount)
            Assert.Equal(0, summary.UnreviewedFailureCount)
            Assert.Equal(0, summary.StaleExpectationCount)
        } finally {
            if string.IsNullOrWhiteSpace(explicitOut) && Directory.Exists(artifactsDir) {
                Directory.Delete(artifactsDir, recursive: true)
            }
        }
    }

    shared {
        internal const PinnedWaikikiCommit string = "ec66d0bfaa39583cd11c66095f2748342dc9e8f6"
        internal const PinnedWaikikiSdkVersion string = "0.5.26"
        private const DefaultRpcTimeoutSeconds int32 = 30
        private const DefaultRpcBatchTimeoutSeconds int32 = 120

        internal func ResolveConfiguredWaikikiCorpusRoot(configuredRoot string?) string? {
            if string.IsNullOrWhiteSpace(configuredRoot) {
                return nil
            }
            let trimmed = configuredRoot.Trim()
            Assert.True(
                Directory.Exists(trimmed),
                "Configured GSHARP_WAIKIKI_CORPUS_ROOT directory does not exist: $trimmed"
            )
            return trimmed
        }

        private let ReviewedFailures[]ReviewedFailure = Array.Empty[ReviewedFailure]()

        private let ReviewedSyntaxGaps[]string = Array.Empty[string]()

        private let ReviewedDidOpenRepointGaps[]string = Array.Empty[string]()

        internal async func RunWorkspaceAuditAsync(
            corpusRoot string,
            artifactsDir string,
            corpusCommit string,
            enforceWaikikiBaseline bool
        ) WorkspaceAuditSummary {
            let stopwatch = Stopwatch.StartNew()
            let documents = DocumentContentService()
            let workspace = WorkspaceState()
            let server = LspServer(documents, workspace)
            let discoveryDone = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
            var discoveryScheduled = false
            server.TestBeforeWorkspaceDiscovery = () -> discoveryScheduled = true
            server.TestAfterWorkspaceDiscovery = () -> {
                discoveryScheduled = true
                discoveryDone.TrySetResult(true)
            }
            let (clientStream, serverStream) = FullDuplexStream.CreatePair()
            using let serverRpc = JsonRpc(
                HeaderDelimitedMessageHandler(serverStream, serverStream, LspJson.CreateFormatter())
            )
            serverRpc.AddLocalRpcTarget(server, JsonRpcTargetOptions{DisposeOnDisconnect: false})
            server.Attach(serverRpc)
            serverRpc.StartListening()
            using let clientRpc = JsonRpc(
                HeaderDelimitedMessageHandler(clientStream, clientStream, LspJson.CreateFormatter())
            )
            clientRpc.StartListening()

            var shutdownSent = false
            try {
                using let initCaps = JsonDocument.Parse(
                    "{\"textDocument\":{\"diagnostic\":{}},\"workspace\":{\"diagnostics\":{\"refreshSupport\":true}}}"
                )
                let _ = await InvokeRpcWithDeadlineAsync[InitializeResult](
                    clientRpc,
                    "initialize",
                    InitializeParams{
                        RootPath: corpusRoot,
                        RootUri: DocumentUri.FromFileSystemPath(corpusRoot)!!,
                        Capabilities: initCaps.RootElement.Clone()
                    }
                )
                await NotifyRpcWithDeadlineAsync(clientRpc, "initialized", AuditEmptyRpcParams())
                discoveryScheduled = true
                await discoveryDone.Task.WaitAsync(TimeSpan.FromSeconds(120))

                let projects = workspace
                    .Projects
                    .OrderBy(
                    (p ProjectState) -> NormalizeRelativePath(corpusRoot, p.ProjectFilePath),
                    StringComparer.Ordinal
                )
                    .ToList()
                Assert.NotEmpty(projects)

                let reviewedFailureList = if enforceWaikikiBaseline {
                    ReviewedFailures
                } else {
                    Array.Empty[ReviewedFailure]()
                }
                let reviewedGapSet = if enforceWaikikiBaseline {
                    ReviewedSyntaxGaps.ToHashSet(StringComparer.Ordinal)
                } else {
                    HashSet[string](StringComparer.Ordinal)
                }
                let reviewedRepointGapSet = if enforceWaikikiBaseline {
                    ReviewedDidOpenRepointGaps.ToHashSet(StringComparer.Ordinal)
                } else {
                    HashSet[string](StringComparer.Ordinal)
                }
                let matchedReviewedFailures = HashSet[string](StringComparer.Ordinal)
                let matchedReviewedGaps = HashSet[string](StringComparer.Ordinal)
                let failures = List[AuditFailureRecord]()
                let fileSummaries = List[FileInventorySummary]()
                let seenFiles = HashSet[string](StringComparer.OrdinalIgnoreCase)

                var authoredFiles = 0
                var generatedFiles = 0
                var totalPhysicalTokens = 0
                var totalChecks = 0
                var excludedSyntheticTokens = 0
                var syntheticLeaks = 0
                var oracleTargets = 0
                var oracleMatched = 0
                var hoverNonNull = 0
                var placeholderHovers = 0
                var interiorMismatches = 0

                for proj in projects {
                    Assert.NotEmpty(proj.References)
                    for refPath in proj.References {
                        Assert.True(File.Exists(refPath), "Missing project reference assembly: $refPath")
                    }
                    let compilation = proj.GetCompilation()
                    let errors = compilation
                        .GetDiagnostics()
                        .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                        .ToList()
                    Assert.Empty(errors)

                    let orderedTrees = compilation
                        .SyntaxTrees
                        .OrderBy(
                        (t SyntaxTree) -> NormalizeRelativePath(corpusRoot, t.Text.FileName),
                        StringComparer.Ordinal
                    )
                        .ToList()
                    for tree in orderedTrees {
                        let filePath = tree.Text.FileName
                        if !seenFiles.Add(filePath) {
                            continue
                        }
                        let relativePath = NormalizeRelativePath(corpusRoot, filePath)
                        let isGenerated = ProjectDiscovery.IsGeneratedSourcePath(filePath)
                        if isGenerated {
                            generatedFiles++
                        } else {
                            authoredFiles++
                        }
                        let rawBytes = File.ReadAllBytes(filePath)
                        let fileSha256 = Convert.ToHexString(SHA256.HashData(rawBytes)).ToLowerInvariant()
                        let text = tree.Text.ToString()
                        let uri = DocumentUri.FromFileSystemPath(filePath)!!
                        let docId = TextDocumentIdentifier{Uri: uri}
                        let coreModel = compilation.GetSemanticModel(tree)
                        let indexedMemberSpans = CollectIndexedMemberTokenSpans(tree.Root)

                        let physicalBySpan = Dictionary[(int32, int32, SyntaxKind), SyntaxToken]()
                        for tok in SyntaxTree.ParseTokens(tree.Text) {
                            if tok.Kind == SyntaxKind.WhitespaceToken ||
                                tok.Kind == SyntaxKind.CommentToken ||
                                tok.Kind == SyntaxKind.DocumentationCommentToken ||
                                tok.Kind == SyntaxKind.EndOfFileToken {
                                continue
                            }
                            if IsPhysicalToken(tree.Text, tok) {
                                physicalBySpan[(tok.Span.Start, tok.Span.End, tok.Kind)] = tok
                            }
                        }
                        for tok in EnumerateTreeTokens(tree.Root) {
                            if tok.Kind == SyntaxKind.EndOfFileToken {
                                continue
                            }
                            if !IsPhysicalToken(tree.Text, tok) {
                                excludedSyntheticTokens++
                                if tok.Span.Start >= 0 && tok.Span.Start <= text.Length {
                                    let hit = SemanticLookup.FindTokenAt(tree, tok.Span.Start)
                                    if IsSyntheticTokenHitLeak(tree.Text, hit) {
                                        syntheticLeaks++
                                        failures.Add(
                                            AuditFailureRecord(
                                                "$relativePath:${tok.Span.Start}:${tok.Text}",
                                                "SyntheticAnchor",
                                                "SyntheticTokenLeak",
                                                "",
                                                true,
                                                "physical token",
                                                "${hit!!.Kind}:${hit!!.Text}"
                                            )
                                        )
                                    }
                                }
                                continue
                            }
                            physicalBySpan[(tok.Span.Start, tok.Span.End, tok.Kind)] = tok
                        }

                        let orderedTokens = physicalBySpan
                            .Values
                            .OrderBy((t SyntaxToken) -> t.Span.Start)
                            .ThenByDescending((t SyntaxToken) -> t.Span.Length)
                            .ToList()
                        totalPhysicalTokens += orderedTokens.Count
                        var fileChecks = 0
                        var fileOracleTargets = 0
                        var fileHovers = 0

                        await NotifyRpcWithDeadlineAsync(
                            clientRpc,
                            "textDocument/didOpen",
                            DidOpenTextDocumentParams{
                                TextDocument: TextDocumentItem{Uri: uri, LanguageId: "gsharp", Version: 1, Text: text}
                            }
                        )
                        try {
                            using let fileRpcCts = CancellationTokenSource(
                                TimeSpan.FromSeconds(DefaultRpcBatchTimeoutSeconds)
                            )
                            let startRanges = [orderedTokens.Count]GSharp.LanguageServer.Protocol.Range
                            let startTasks = [orderedTokens.Count]Task[Hover?]
                            let interiorTasks = [orderedTokens.Count]Task[Hover?]?
                            for var idx = 0; idx < orderedTokens.Count; idx++ {
                                let tok = orderedTokens[idx]
                                let startRange = SemanticLookup.ToRange(tree.Text, tok.Span)
                                startRanges[idx] = startRange
                                startTasks[idx] = clientRpc.InvokeWithParameterObjectAsync[Hover?](
                                    "textDocument/hover",
                                    HoverParams{TextDocument: docId, Position: startRange.Start},
                                    fileRpcCts.Token
                                )
                                if tok.Span.Length >= 2 && tok.Kind != SyntaxKind.InterpolatedStringToken {
                                    let interiorPos = SemanticLookup.ToRange(tree.Text, TextSpan(tok.Span.Start + 1, 0))
                                        .Start
                                    interiorTasks[idx] = clientRpc.InvokeWithParameterObjectAsync[Hover?](
                                        "textDocument/hover",
                                        HoverParams{TextDocument: docId, Position: interiorPos},
                                        fileRpcCts.Token
                                    )
                                }
                            }
                            await Task.WhenAll(startTasks).WaitAsync(
                                TimeSpan.FromSeconds(DefaultRpcBatchTimeoutSeconds)
                            )

                            for var idx = 0; idx < orderedTokens.Count; idx++ {
                                let tok = orderedTokens[idx]
                                let startRange = startRanges[idx]
                                let line1 = startRange.Start.Line + 1
                                let col1 = startRange.Start.Character + 1
                                let targetId = "$relativePath:$line1:$col1:${tok.Text}"
                                let role = ClassifyTokenRole(tok, indexedMemberSpans)
                                let hover = await startTasks[idx].WaitAsync(
                                    TimeSpan.FromSeconds(DefaultRpcTimeoutSeconds)
                                )
                                fileChecks++
                                totalChecks++

                                var interiorMatches = true
                                var interiorHover Hover? = nil
                                if interiorTasks[idx] != nil {
                                    fileChecks++
                                    totalChecks++
                                    interiorHover = await interiorTasks[idx]!!.WaitAsync(
                                        TimeSpan.FromSeconds(DefaultRpcTimeoutSeconds)
                                    )
                                    if ExtractSignature(hover) != ExtractSignature(interiorHover) ||
                                        !RangesEqual(hover?.Range, interiorHover?.Range) {
                                        interiorMatches = false
                                        interiorMismatches++
                                    }
                                }

                                var rangeMatches = true
                                var isPlaceholderHover = false
                                var recordedPlaceholderHover = false
                                var recordedInteriorMismatch = false
                                let actualSig = ExtractSignature(hover)
                                if hover != nil {
                                    fileHovers++
                                    hoverNonNull++
                                    if !RangesEqual(hover.Range, startRange) {
                                        rangeMatches = false
                                        let rangeFailure = EvaluateTargetCheck(
                                            targetId,
                                            role,
                                            FormatRange(startRange),
                                            FormatRange(hover.Range),
                                            rangeMatches: false,
                                            interiorMatches: interiorMatches,
                                            definitionMatches: true,
                                            reviewedFailureList,
                                            matchedReviewedFailures
                                        )
                                        if rangeFailure != nil {
                                            failures.Add(rangeFailure)
                                            if rangeFailure.Kind == "InteriorHoverMismatch" {
                                                recordedInteriorMismatch = true
                                            }
                                            if rangeFailure.Kind == "PlaceholderType" {
                                                recordedPlaceholderHover = true
                                            }
                                        }
                                    }
                                    if IsPlaceholderTypeSignature(actualSig) {
                                        isPlaceholderHover = true
                                        placeholderHovers++
                                    }
                                }

                                if tok.Kind == SyntaxKind.IdentifierToken {
                                    let declSym = GetDeclaredSymbolIfIdentifier(coreModel, tok)
                                    let refSym = coreModel.GetSymbolInfo(tok).Symbol
                                    let sym = declSym ?? refSym
                                    if sym != nil && sym is not PackageSymbol && sym is not ImportSymbol {
                                        oracleTargets++
                                        fileOracleTargets++
                                        let expectedSig = ExpectedOracleSignature(sym, compilation, tok)
                                        var defMatches = true
                                        if role == "IndexedMemberAccess" && !BoundSemantics.IsImportedMember(sym) {
                                            defMatches = await DefinitionMatchesOracleSymbolOverRpcAsync(
                                                clientRpc,
                                                uri,
                                                startRange.Start,
                                                compilation,
                                                sym
                                            )
                                        }
                                        let outcome = EvaluateTargetCheck(
                                            targetId,
                                            role,
                                            expectedSig,
                                            actualSig,
                                            rangeMatches: true,
                                            interiorMatches: interiorMatches,
                                            definitionMatches: defMatches,
                                            reviewedFailureList,
                                            matchedReviewedFailures
                                        )
                                        if outcome == nil {
                                            oracleMatched++
                                        } else {
                                            failures.Add(outcome)
                                            if outcome.Kind == "InteriorHoverMismatch" {
                                                recordedInteriorMismatch = true
                                            }
                                            if outcome.Kind == "PlaceholderType" {
                                                recordedPlaceholderHover = true
                                            }
                                        }
                                    } else if hover == nil && IsEligibleUnboundIdentifier(tok) {
                                        let gapKey = "$targetId|${tok.Parent?.GetType().Name ?? "none"}"
                                        if reviewedGapSet.Contains(gapKey) {
                                            matchedReviewedGaps.Add(gapKey)
                                            failures.Add(
                                                AuditFailureRecord(
                                                    targetId,
                                                    role,
                                                    "ReviewedSyntaxGap",
                                                    "#5900",
                                                    false,
                                                    "hover for $role",
                                                    ""
                                                )
                                            )
                                        } else if reviewedRepointGapSet.Contains(gapKey) {
                                            matchedReviewedGaps.Add(gapKey)
                                            failures.Add(
                                                AuditFailureRecord(
                                                    targetId,
                                                    role,
                                                    "ReviewedSyntaxGap",
                                                    "#5904",
                                                    false,
                                                    "hover for $role",
                                                    ""
                                                )
                                            )
                                        } else {
                                            failures.Add(
                                                AuditFailureRecord(
                                                    targetId,
                                                    role,
                                                    "UnreviewedSyntaxGap",
                                                    "",
                                                    true,
                                                    "hover for $role",
                                                    ""
                                                )
                                            )
                                        }
                                    }
                                }

                                RecordPlaceholderHoverIfUnrecorded(
                                    targetId,
                                    role,
                                    actualSig,
                                    isPlaceholderHover,
                                    recordedPlaceholderHover,
                                    reviewedFailureList,
                                    matchedReviewedFailures,
                                    failures
                                )
                                RecordInteriorMismatchIfUnrecorded(
                                    targetId,
                                    role,
                                    hover,
                                    interiorHover,
                                    interiorMatches,
                                    recordedInteriorMismatch,
                                    reviewedFailureList,
                                    matchedReviewedFailures,
                                    failures
                                )
                            }
                        } finally {
                            await NotifyRpcWithDeadlineAsync(
                                clientRpc,
                                "textDocument/didClose",
                                DidCloseTextDocumentParams{TextDocument: docId}
                            )
                        }

                        fileSummaries.Add(
                            FileInventorySummary(
                                relativePath,
                                fileSha256,
                                isGenerated,
                                orderedTokens.Count,
                                fileChecks,
                                fileOracleTargets,
                                fileHovers
                            )
                        )
                    }
                }

                await InvokeShutdownWithDeadlineAsync(clientRpc)
                shutdownSent = true
                var staleExpectationCount = 0
                for reviewed in reviewedFailureList {
                    if !matchedReviewedFailures.Contains(reviewed.TargetId) {
                        staleExpectationCount++
                        failures.Add(
                            AuditFailureRecord(
                                reviewed.TargetId,
                                "ReviewedExpectation",
                                "StaleReviewedExpectation",
                                reviewed.Issue,
                                true,
                                reviewed.Expected,
                                "target now passes or is missing"
                            )
                        )
                    }
                }
                for gap in reviewedGapSet.Concat(reviewedRepointGapSet) {
                    if !matchedReviewedGaps.Contains(gap) {
                        staleExpectationCount++
                        failures.Add(
                            AuditFailureRecord(
                                gap,
                                "ReviewedSyntaxGap",
                                "StaleReviewedSyntaxGap",
                                if reviewedRepointGapSet.Contains(gap) {
                                    "#5904"
                                } else {
                                    "#5900"
                                },
                                true,
                                "missing hover",
                                "target now has hover or is missing"
                            )
                        )
                    }
                }

                stopwatch.Stop()
                let unreviewedCount = failures.Count((f AuditFailureRecord) -> f.IsUnreviewed)
                let summary = WorkspaceAuditSummary(
                    corpusCommit,
                    PinnedWaikikiSdkVersion,
                    RuntimeOperatingSystemName(),
                    projects.Count,
                    authoredFiles,
                    generatedFiles,
                    totalPhysicalTokens,
                    totalChecks,
                    excludedSyntheticTokens,
                    syntheticLeaks,
                    oracleTargets,
                    oracleMatched,
                    hoverNonNull,
                    placeholderHovers,
                    interiorMismatches,
                    matchedReviewedFailures.Count,
                    matchedReviewedGaps.Count,
                    unreviewedCount,
                    staleExpectationCount,
                    stopwatch.ElapsedMilliseconds
                )
                WriteAuditArtifacts(artifactsDir, summary, fileSummaries, failures)
                return summary
            } finally {
                if !shutdownSent {
                    server.Shutdown()
                }
                if discoveryScheduled {
                    await discoveryDone.Task.WaitAsync(TimeSpan.FromSeconds(30))
                }
            }
        }

        internal func EvaluateTargetCheck(
            targetId string,
            role string,
            expected string,
            actual string,
            rangeMatches bool,
            interiorMatches bool,
            definitionMatches bool,
            reviewed[]ReviewedFailure,
            matchedReviewed HashSet[string]
        ) AuditFailureRecord? {
            var kind string? = nil
            if string.IsNullOrEmpty(actual) {
                kind = "MissingCompilerSymbolHover"
            } else if IsPlaceholderTypeSignature(actual) {
                kind = "PlaceholderType"
            } else if !rangeMatches {
                kind = "RangeMismatch"
            } else if !interiorMatches {
                kind = "InteriorHoverMismatch"
            } else if !definitionMatches {
                kind = "MissingSourceDefinition"
            } else if expected != actual {
                kind = "SignatureMismatch"
            }
            if kind == nil {
                return nil
            }
            for item in reviewed {
                if item.TargetId == targetId &&
                    item.Kind == kind &&
                    item.Expected == expected &&
                    item.Actual == actual {
                    matchedReviewed.Add(targetId)
                    return AuditFailureRecord(targetId, role, kind, item.Issue, false, expected, actual)
                }
            }
            return AuditFailureRecord(targetId, role, kind, "", true, expected, actual)
        }

        internal func RecordPlaceholderHoverIfUnrecorded(
            targetId string,
            role string,
            actualSignature string,
            isPlaceholderHover bool,
            alreadyRecorded bool,
            reviewed[]ReviewedFailure,
            matchedReviewed HashSet[string],
            failures List[AuditFailureRecord]
        ) {
            if !isPlaceholderHover || alreadyRecorded {
                return
            }
            let expected = "resolved non-placeholder hover for $role"
            for item in reviewed {
                if item.TargetId == targetId &&
                    item.Kind == "PlaceholderType" &&
                    item.Expected == expected &&
                    item.Actual == actualSignature {
                    matchedReviewed.Add(targetId)
                    failures.Add(
                        AuditFailureRecord(
                            targetId,
                            role,
                            "PlaceholderType",
                            item.Issue,
                            false,
                            expected,
                            actualSignature
                        )
                    )
                    return
                }
            }
            failures.Add(AuditFailureRecord(targetId, role, "PlaceholderType", "", true, expected, actualSignature))
        }

        internal func RecordInteriorMismatchIfUnrecorded(
            targetId string,
            role string,
            startHover Hover?,
            interiorHover Hover?,
            interiorMatches bool,
            alreadyRecorded bool,
            reviewed[]ReviewedFailure,
            matchedReviewed HashSet[string],
            failures List[AuditFailureRecord]
        ) {
            if interiorMatches || alreadyRecorded {
                return
            }
            let expected = "${ExtractSignature(startHover)}@${FormatRange(startHover?.Range)}"
            let actual = "${ExtractSignature(interiorHover)}@${FormatRange(interiorHover?.Range)}"
            for item in reviewed {
                if item.TargetId == targetId &&
                    item.Kind == "InteriorHoverMismatch" &&
                    item.Expected == expected &&
                    item.Actual == actual {
                    matchedReviewed.Add(targetId)
                    failures.Add(
                        AuditFailureRecord(targetId, role, "InteriorHoverMismatch", item.Issue, false, expected, actual)
                    )
                    return
                }
            }
            failures.Add(AuditFailureRecord(targetId, role, "InteriorHoverMismatch", "", true, expected, actual))
        }

        private async func InvokeRpcWithDeadlineAsync[T](
            clientRpc JsonRpc,
            method string,
            argument object?,
            timeoutSeconds int32 = 30
        ) T {
            using let cts = CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds))
            return await clientRpc.InvokeWithParameterObjectAsync[T](method, argument, cts.Token).WaitAsync(
                TimeSpan.FromSeconds(timeoutSeconds)
            )
        }

        private async func NotifyRpcWithDeadlineAsync(
            clientRpc JsonRpc,
            method string,
            argument object?,
            timeoutSeconds int32 = 30
        ) {
            await clientRpc.NotifyWithParameterObjectAsync(method, argument).WaitAsync(
                TimeSpan.FromSeconds(timeoutSeconds)
            )
        }

        private async func InvokeShutdownWithDeadlineAsync(clientRpc JsonRpc, timeoutSeconds int32 = 30) {
            using let cts = CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds))
            let _ = await clientRpc.InvokeWithCancellationAsync[object]("shutdown", Array.Empty[object?](), cts.Token)
                .WaitAsync(TimeSpan.FromSeconds(timeoutSeconds))
        }

        private async func VerifyLifecyclePhasesOverRpcAsync(
            workspaceRoot string,
            targetFilePath string,
            siblingDeclarationPath string,
            localSymbolName string,
            expectedLocalHover string,
            guardSymbolName string,
            expectedGuardHover string,
            expectedGuardCallHover string,
            indexedPropName string,
            expectedIndexedPropHover string,
            indexedArrayPropName string,
            expectedIndexedArrayPropHover string
        ) {
            let originalSource = File.ReadAllText(targetFilePath)
            let siblingSource = File.ReadAllText(siblingDeclarationPath)
            let canonicalUri = DocumentUri.FromFileSystemPath(targetFilePath)!!
            let siblingUri = DocumentUri.FromFileSystemPath(siblingDeclarationPath)!!
            let indexedDeclPos = LanguageServerTestHelpers.PositionOf(siblingSource, "prop " + indexedPropName + " ", 0)
            let expectedIndexedPropDeclLoc = Location{
                Uri: siblingUri,
                Range: GSharp
                    .LanguageServer
                    .Protocol
                    .Range(
                    Position(indexedDeclPos.Line, indexedDeclPos.Character + 5),
                    Position(indexedDeclPos.Line, indexedDeclPos.Character + 5 + indexedPropName.Length)
                )
            }

            // Phase 1: Cold-open before project discovery completes (#5024).
            {
                let documents = DocumentContentService()
                let workspace = WorkspaceState()
                let server = LspServer(documents, workspace)
                let discoveryStarted = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
                let proceedDiscovery = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
                let discoveryFinished = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
                var discoveryScheduled = false
                server.TestBeforeWorkspaceDiscovery = () -> {
                    discoveryScheduled = true
                    discoveryStarted.TrySetResult(true)
                    proceedDiscovery.Task.GetAwaiter().GetResult()
                }
                server.TestAfterWorkspaceDiscovery = () -> {
                    discoveryScheduled = true
                    discoveryFinished.TrySetResult(true)
                }

                let (clientStream, serverStream) = FullDuplexStream.CreatePair()
                using let serverRpc = JsonRpc(
                    HeaderDelimitedMessageHandler(serverStream, serverStream, LspJson.CreateFormatter())
                )
                serverRpc.AddLocalRpcTarget(server, JsonRpcTargetOptions{DisposeOnDisconnect: false})
                server.Attach(serverRpc)
                serverRpc.StartListening()
                using let clientRpc = JsonRpc(
                    HeaderDelimitedMessageHandler(clientStream, clientStream, LspJson.CreateFormatter())
                )
                clientRpc.StartListening()

                var shutdownSent = false
                try {
                    using let caps = JsonDocument.Parse(
                        "{\"textDocument\":{\"diagnostic\":{}},\"workspace\":{\"diagnostics\":{\"refreshSupport\":true}}}"
                    )
                    let _ = await InvokeRpcWithDeadlineAsync[InitializeResult](
                        clientRpc,
                        "initialize",
                        InitializeParams{RootPath: workspaceRoot, Capabilities: caps.RootElement.Clone()}
                    )
                    await NotifyRpcWithDeadlineAsync(
                        clientRpc,
                        "textDocument/didOpen",
                        DidOpenTextDocumentParams{
                            TextDocument: TextDocumentItem{
                                Uri: canonicalUri,
                                LanguageId: "gsharp",
                                Version: 1,
                                Text: originalSource
                            }
                        }
                    )
                    let preDiscoveryDiag = await InvokeRpcWithDeadlineAsync[FullDocumentDiagnosticReport](
                        clientRpc,
                        "textDocument/diagnostic",
                        DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: canonicalUri}}
                    )
                    Assert.NotNull(preDiscoveryDiag)
                    Assert.Empty(preDiscoveryDiag.Items)
                    Assert.Null(workspace.GetProjectForFile(targetFilePath))

                    await NotifyRpcWithDeadlineAsync(clientRpc, "initialized", AuditEmptyRpcParams())
                    discoveryScheduled = true
                    await discoveryStarted.Task.WaitAsync(TimeSpan.FromSeconds(30))
                    proceedDiscovery.TrySetResult(true)
                    await discoveryFinished.Task.WaitAsync(TimeSpan.FromSeconds(120))

                    await AssertLifecycleTargetsOverRpcAsync(
                        clientRpc,
                        canonicalUri,
                        expectedIndexedPropDeclLoc,
                        originalSource,
                        localSymbolName,
                        expectedLocalHover,
                        guardSymbolName,
                        expectedGuardHover,
                        expectedGuardCallHover,
                        indexedPropName,
                        expectedIndexedPropHover,
                        indexedArrayPropName,
                        expectedIndexedArrayPropHover
                    )
                    await InvokeShutdownWithDeadlineAsync(clientRpc)
                    shutdownSent = true
                } finally {
                    proceedDiscovery.TrySetResult(true)
                    if !shutdownSent {
                        server.Shutdown()
                    }
                    if discoveryScheduled {
                        await discoveryFinished.Task.WaitAsync(TimeSpan.FromSeconds(30))
                    }
                }
            }

            // Phase 2 & 3 & 4: Restart/reinitialize, reopen + repeated body-only edits (#5025),
            // canonical and Windows VS Code-style drive URIs, and full-rebind control.
            let uriVariants = List[DocumentUri]{canonicalUri}
            if OperatingSystem.IsWindows() && targetFilePath.Length >= 2 && targetFilePath[1] == ':' {
                let vscodeUriText = canonicalUri.ToString().Replace(
                    targetFilePath.Substring(0, 2),
                    targetFilePath.Substring(0, 1).ToLowerInvariant() + "%3A",
                    StringComparison.OrdinalIgnoreCase
                )
                uriVariants.Add(DocumentUri.From(vscodeUriText)!!)
            } else {
                // Verify encoded Windows drive URI parsing deterministically even on POSIX runners.
                let syntheticWinUri = DocumentUri.From("file:///c%3A/waikiki/TokenStoreTests.gs")!!
                Assert.Contains("%3A", syntheticWinUri.ToString(), StringComparison.Ordinal)
            }

            for activeUri in uriVariants {
                let documents = DocumentContentService()
                let workspace = WorkspaceState()
                let server = LspServer(documents, workspace)
                let discoveryFinished = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
                var discoveryScheduled = false
                server.TestBeforeWorkspaceDiscovery = () -> discoveryScheduled = true
                server.TestAfterWorkspaceDiscovery = () -> {
                    discoveryScheduled = true
                    discoveryFinished.TrySetResult(true)
                }

                let (clientStream, serverStream) = FullDuplexStream.CreatePair()
                using let serverRpc = JsonRpc(
                    HeaderDelimitedMessageHandler(serverStream, serverStream, LspJson.CreateFormatter())
                )
                serverRpc.AddLocalRpcTarget(server, JsonRpcTargetOptions{DisposeOnDisconnect: false})
                server.Attach(serverRpc)
                serverRpc.StartListening()
                using let clientRpc = JsonRpc(
                    HeaderDelimitedMessageHandler(clientStream, clientStream, LspJson.CreateFormatter())
                )
                clientRpc.StartListening()

                var shutdownSent = false
                try {
                    using let caps = JsonDocument.Parse(
                        "{\"textDocument\":{\"diagnostic\":{}},\"workspace\":{\"diagnostics\":{\"refreshSupport\":true}}}"
                    )
                    let _ = await InvokeRpcWithDeadlineAsync[InitializeResult](
                        clientRpc,
                        "initialize",
                        InitializeParams{RootPath: workspaceRoot, Capabilities: caps.RootElement.Clone()}
                    )
                    await NotifyRpcWithDeadlineAsync(clientRpc, "initialized", AuditEmptyRpcParams())
                    discoveryScheduled = true
                    await discoveryFinished.Task.WaitAsync(TimeSpan.FromSeconds(120))

                    await NotifyRpcWithDeadlineAsync(
                        clientRpc,
                        "textDocument/didOpen",
                        DidOpenTextDocumentParams{
                            TextDocument: TextDocumentItem{
                                Uri: activeUri,
                                LanguageId: "gsharp",
                                Version: 1,
                                Text: originalSource
                            }
                        }
                    )
                    await AssertLifecycleTargetsOverRpcAsync(
                        clientRpc,
                        activeUri,
                        expectedIndexedPropDeclLoc,
                        originalSource,
                        localSymbolName,
                        expectedLocalHover,
                        guardSymbolName,
                        expectedGuardHover,
                        expectedGuardCallHover,
                        indexedPropName,
                        expectedIndexedPropHover,
                        indexedArrayPropName,
                        expectedIndexedArrayPropHover
                    )

                    // Reopen document and apply repeated body-only edits (#5025).
                    await NotifyRpcWithDeadlineAsync(
                        clientRpc,
                        "textDocument/didClose",
                        DidCloseTextDocumentParams{TextDocument: TextDocumentIdentifier{Uri: activeUri}}
                    )
                    await NotifyRpcWithDeadlineAsync(
                        clientRpc,
                        "textDocument/didOpen",
                        DidOpenTextDocumentParams{
                            TextDocument: TextDocumentItem{
                                Uri: activeUri,
                                LanguageId: "gsharp",
                                Version: 2,
                                Text: originalSource
                            }
                        }
                    )

                    let project = Assert.IsType[ProjectState](workspace.GetProjectForFile(targetFilePath))
                    let initialScope = project.GetCompilation().GlobalScope
                    let bodyEdits = []string{
                        originalSource.Replace("let call = runner.Calls[0]", "let call =  runner.Calls[0]"),
                        originalSource.Replace("let call = runner.Calls[0]", "let call = runner.Calls[0]\n        "),
                        originalSource
                    }
                    var version = 3
                    for edited in bodyEdits {
                        await NotifyRpcWithDeadlineAsync(
                            clientRpc,
                            "textDocument/didChange",
                            DidChangeTextDocumentParams{
                                TextDocument: VersionedTextDocumentIdentifier{Uri: activeUri, Version: version++},
                                ContentChanges: List[TextDocumentContentChangeEvent]{
                                    TextDocumentContentChangeEvent{Text: edited}
                                }
                            }
                        )
                        await AssertLifecycleTargetsOverRpcAsync(
                            clientRpc,
                            activeUri,
                            expectedIndexedPropDeclLoc,
                            edited,
                            localSymbolName,
                            expectedLocalHover,
                            guardSymbolName,
                            expectedGuardHover,
                            expectedGuardCallHover,
                            indexedPropName,
                            expectedIndexedPropHover,
                            indexedArrayPropName,
                            expectedIndexedArrayPropHover
                        )
                        Assert.Same(initialScope, project.GetCompilation().GlobalScope)
                    }

                    // Full-rebind diagnostic control after body-only edit checks pass.
                    let fullRebindSource = originalSource + "\nfunc AuditFullRebindControl() int32 -> 1\n"
                    await NotifyRpcWithDeadlineAsync(
                        clientRpc,
                        "textDocument/didChange",
                        DidChangeTextDocumentParams{
                            TextDocument: VersionedTextDocumentIdentifier{Uri: activeUri, Version: version++},
                            ContentChanges: List[TextDocumentContentChangeEvent]{
                                TextDocumentContentChangeEvent{Text: fullRebindSource}
                            }
                        }
                    )
                    await AssertLifecycleTargetsOverRpcAsync(
                        clientRpc,
                        activeUri,
                        expectedIndexedPropDeclLoc,
                        fullRebindSource,
                        localSymbolName,
                        expectedLocalHover,
                        guardSymbolName,
                        expectedGuardHover,
                        expectedGuardCallHover,
                        indexedPropName,
                        expectedIndexedPropHover,
                        indexedArrayPropName,
                        expectedIndexedArrayPropHover
                    )
                    Assert.NotSame(initialScope, project.GetCompilation().GlobalScope)

                    await NotifyRpcWithDeadlineAsync(
                        clientRpc,
                        "textDocument/didChange",
                        DidChangeTextDocumentParams{
                            TextDocument: VersionedTextDocumentIdentifier{Uri: activeUri, Version: version++},
                            ContentChanges: List[TextDocumentContentChangeEvent]{
                                TextDocumentContentChangeEvent{Text: originalSource}
                            }
                        }
                    )
                    await InvokeShutdownWithDeadlineAsync(clientRpc)
                    shutdownSent = true
                } finally {
                    if !shutdownSent {
                        server.Shutdown()
                    }
                    if discoveryScheduled {
                        await discoveryFinished.Task.WaitAsync(TimeSpan.FromSeconds(30))
                    }
                }
            }
            Assert.Equal(originalSource, File.ReadAllText(targetFilePath))
        }

        private async func AssertLifecycleTargetsOverRpcAsync(
            clientRpc JsonRpc,
            uri DocumentUri,
            expectedIndexedPropDeclLoc Location,
            source string,
            localSymbolName string,
            expectedLocalHover string,
            guardSymbolName string,
            expectedGuardHover string,
            expectedGuardCallHover string,
            indexedPropName string,
            expectedIndexedPropHover string,
            indexedArrayPropName string,
            expectedIndexedArrayPropHover string
        ) {
            let diagReport = await InvokeRpcWithDeadlineAsync[FullDocumentDiagnosticReport](
                clientRpc,
                "textDocument/diagnostic",
                DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}}
            )
            Assert.NotNull(diagReport)
            Assert.Empty(diagReport.Items)

            let localPos = LanguageServerTestHelpers.PositionOf(source, "let " + localSymbolName + " =", 0)
            let localIdPos = Position(localPos.Line, localPos.Character + 4)
            let localHover = await InvokeRpcWithDeadlineAsync[Hover?](
                clientRpc,
                "textDocument/hover",
                HoverParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Position: localIdPos}
            )
            Assert.NotNull(localHover)
            Assert.Equal(expectedLocalHover, ExtractSignature(localHover))
            Assert.DoesNotContain(" ?", ExtractSignature(localHover), StringComparison.Ordinal)

            let guardPos = LanguageServerTestHelpers.PositionOf(source, "guard let " + guardSymbolName + " =", 0)
            let guardIdPos = Position(guardPos.Line, guardPos.Character + 10)
            let guardHover = await InvokeRpcWithDeadlineAsync[Hover?](
                clientRpc,
                "textDocument/hover",
                HoverParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Position: guardIdPos}
            )
            Assert.NotNull(guardHover)
            Assert.Equal(expectedGuardHover, ExtractSignature(guardHover))

            let guardCallPos = LanguageServerTestHelpers.PositionOf(source, guardSymbolName + ".LoadAsync()", 0)
            let guardMethodPos = Position(guardCallPos.Line, guardCallPos.Character + guardSymbolName.Length + 1)
            let guardCallHover = await InvokeRpcWithDeadlineAsync[Hover?](
                clientRpc,
                "textDocument/hover",
                HoverParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Position: guardMethodPos}
            )
            Assert.NotNull(guardCallHover)
            Assert.Equal(expectedGuardCallHover, ExtractSignature(guardCallHover))

            let indexedPropPos = LanguageServerTestHelpers.PositionOf(source, indexedPropName + "[0]", 0)
            let indexedPropHover = await InvokeRpcWithDeadlineAsync[Hover?](
                clientRpc,
                "textDocument/hover",
                HoverParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Position: indexedPropPos}
            )
            Assert.NotNull(indexedPropHover)
            Assert.Equal(expectedIndexedPropHover, ExtractSignature(indexedPropHover))

            let indexedPropDefs = await InvokeRpcWithDeadlineAsync[IReadOnlyList[Location]](
                clientRpc,
                "textDocument/definition",
                DefinitionParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Position: indexedPropPos}
            )
            Assert.NotEmpty(indexedPropDefs)
            Assert.True(LocationsMatchExpectedDeclaration(expectedIndexedPropDeclLoc, indexedPropDefs[0]))

            let indexedArrayPos = LanguageServerTestHelpers.PositionOf(source, indexedArrayPropName + "[0]", 0)
            let indexedArrayHover = await InvokeRpcWithDeadlineAsync[Hover?](
                clientRpc,
                "textDocument/hover",
                HoverParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Position: indexedArrayPos}
            )
            Assert.NotNull(indexedArrayHover)
            Assert.Equal(expectedIndexedArrayPropHover, ExtractSignature(indexedArrayHover))
        }

        private func WriteSmallDeterministicCorpus(corpusRoot string) {
            File.WriteAllText(Path.Combine(corpusRoot, "AuditSample.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <AssemblyName>AuditSample</AssemblyName>
  </PropertyGroup>
</Project>
`)
            let objDir = Path.Combine(corpusRoot, "obj", "Debug", "net10.0")
            let gsgenDir = Path.Combine(objDir, "gsgen")
            Directory.CreateDirectory(gsgenDir)

            let netCoreDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let rspLines = List[string]()
            for dllPath in[]string{
                typeof(object).Assembly.Location,
                Path.Combine(netCoreDir, "System.Runtime.dll"),
                Path.Combine(netCoreDir, "System.Collections.dll"),
                Path.Combine(netCoreDir, "System.Memory.dll"),
                typeof(Uri).Assembly.Location,
                typeof(System.Text.Json.Nodes.JsonNode).Assembly.Location
            }.Distinct(StringComparer.OrdinalIgnoreCase) {
                if File.Exists(dllPath) {
                    rspLines.Add("/r:\"$dllPath\"")
                }
            }
            File.WriteAllLines(Path.Combine(objDir, "AuditSample.rsp"), rspLines)

            File.WriteAllText(Path.Combine(corpusRoot, "Models.gs"), `package AuditSample

import System
import System.Collections.Generic
import System.Threading.Tasks

interface ITokenStore {
    func LoadAsync() Task[TokenSet?];
}

data class TokenSet {
    init(accessToken string, refreshToken string?) {
        AccessToken = accessToken
        RefreshToken = refreshToken
    }

    prop AccessToken string {
        get;
        init;
    }

    prop RefreshToken string? {
        get;
        init;
    }
}

data class RunnerCall {
    init(fileName string, args []string) {
        FileName = fileName
        Args = args
    }

    prop FileName string {
        get;
        init;
    }

    prop Args []string {
        get;
        init;
    }
}

class FakeRunner : ITokenStore {
    private let calls List[RunnerCall]
    private let tokenResult Task[TokenSet?]

    init(calls List[RunnerCall], tokenResult Task[TokenSet?]) {
        this.calls = calls
        this.tokenResult = tokenResult
    }

    prop Calls List[RunnerCall] -> calls

    func LoadAsync() Task[TokenSet?] -> tokenResult
}

partial class GeneratedHost {
    prop Prefix string -> "host"
}

let Args = "global"
`)

            File.WriteAllText(Path.Combine(gsgenDir, "Consumer.Generated.g.gs"), `package AuditSample

partial class GeneratedHost {
    func GeneratedTag() string -> "generated"
}
`)

            File.WriteAllText(Path.Combine(corpusRoot, "Consumer.gs"), `package AuditSample

import System
import System.Collections.Generic
import System.Text.Json.Nodes
import System.Threading.Tasks

class Consumer {
    prop Address Uri -> Uri("https://example.test/one/two")

    async func Run(
        runner FakeRunner,
        nullableRunner FakeRunner?,
        decoyNode JsonNode,
        genHost GeneratedHost,
        memory Memory[int32],
        roMemory ReadOnlyMemory[int32]
    ) string {
        var store ITokenStore? = runner
        guard let s = store else {
            return ""
        }
        let loaded = await s.LoadAsync()
        let plainCalls = runner.Calls
        let call = runner.Calls[0]
        let lastCall = runner.Calls[^1]
        let plainArgs = call.Args
        let firstArg = call.Args[0]
        let allArgs = call.Args[..]
        let plainFile = call.FileName
        let firstChar = call.FileName[0]
        let middleChars = call.FileName[1..^1]
        let tailLen = runner.Calls[0].FileName.Length
        let uri = this.Address
        let segs = uri.Segments
        let firstSeg = uri.Segments[0]
        let host = uri.Host
        let firstHostChar = uri.Host[0]
        let decoy = decoyNode.ToString()
        let uriText = uri.ToString()
        let uriFirstChar = uri.ToString()[0]
        let Calls = 0
        let Args = 0
        let collided = runner.Calls[Calls].Args[Args]
        let optCall = nullableRunner?.Calls[^1]
        let memElem = memory.Span[0]
        let roMemElem = roMemory.Span[0]
        let bareLocal = plainArgs[0]
        let tag = genHost.GeneratedTag()
        return "user=${loaded!!.AccessToken} tag=$tag first=$firstArg bare=$bareLocal char=$uriFirstChar"
    }
}
`)
        }

        private func AssertHoverAt(
            content DocumentContent,
            source string,
            marker string,
            occurrence int32,
            expectedToken string,
            expectedSignature string
        ) Hover {
            let pos = LanguageServerTestHelpers.PositionOf(source, marker, occurrence)
            let hover = Assert.IsType[Hover](HoverComputer.ComputeHover(content, pos))
            Assert.Equal(expectedSignature, ExtractSignature(hover))
            Assert.Equal(pos.Line, hover.Range.Start.Line)
            Assert.Equal(pos.Character, hover.Range.Start.Character)
            Assert.Equal(pos.Line, hover.Range.End.Line)
            Assert.Equal(pos.Character + expectedToken.Length, hover.Range.End.Character)
            if expectedToken.Length >= 2 {
                let interiorPos = Position(pos.Line, pos.Character + 1)
                let interiorHover = Assert.IsType[Hover](HoverComputer.ComputeHover(content, interiorPos))
                Assert.Equal(expectedSignature, ExtractSignature(interiorHover))
                Assert.True(RangesEqual(hover.Range, interiorHover.Range))
            }
            return hover
        }

        private async func DefinitionMatchesOracleSymbolOverRpcAsync(
            clientRpc JsonRpc,
            uri DocumentUri,
            position Position,
            compilation Compilation,
            symbol Symbol
        ) bool {
            let actualLocs = await InvokeRpcWithDeadlineAsync[IReadOnlyList[Location]](
                clientRpc,
                "textDocument/definition",
                DefinitionParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Position: position}
            )
            if actualLocs == nil || actualLocs.Count == 0 {
                return false
            }
            if !TryGetExpectedSourceDeclarationLocation(compilation, symbol, uri, out var expectedLoc) {
                return false
            }
            return LocationsMatchExpectedDeclaration(expectedLoc, actualLocs[0])
        }

        private func LocationsMatchExpectedDeclaration(expectedLoc Location?, actualLoc Location?) bool {
            if expectedLoc == nil || actualLoc == nil {
                return false
            }
            return ServerPathIdentity.AreSame(
                expectedLoc.Uri?.GetFileSystemPath(),
                actualLoc.Uri?.GetFileSystemPath()
            ) &&
                RangesEqual(expectedLoc.Range, actualLoc.Range)
        }

        private func TryGetExpectedSourceDeclarationLocation(
            compilation Compilation,
            symbol Symbol,
            fallbackUri DocumentUri,
            out expectedLocation Location?
        ) bool {
            expectedLocation = nil
            let declToken = switch symbol {
                case p is PropertySymbol when p.Declaration != nil: p.Declaration!!.Identifier
                case f is FunctionSymbol when f.Declaration != nil: f.Declaration!!.Identifier
                case f is FunctionSymbol when f.LocalDeclaration != nil: f.LocalDeclaration!!.Identifier
                case fld is FieldSymbol when fld.Declaration is FieldDeclarationSyntax fd: fd.Identifier
                case fld is FieldSymbol when fld.Declaration is ParameterSyntax pd: pd.Identifier
                case ev is EventSymbol when ev.Declaration != nil: ev.Declaration!!.Identifier
                case s is StructSymbol when s.Declaration != nil: s.Declaration!!.Identifier
                case i is InterfaceSymbol when i.Declaration != nil: i.Declaration.Identifier
                case e is EnumSymbol when e.Declaration != nil: e.Declaration.Identifier
                default: default(SyntaxToken?)
            }
            if declToken == nil || declToken.SyntaxTree?.Text == nil {
                return false
            }
            let fileName = declToken.SyntaxTree.Text.FileName
            let targetUri = if !string.IsNullOrEmpty(fileName) {
                DocumentUri.FromFileSystemPath(fileName)!!
            } else {
                fallbackUri
            }
            expectedLocation = Location{Uri: targetUri, Range: SemanticLookup.ToRange(declToken)}
            return true
        }

        private func CollectIndexedMemberTokenSpans(root SyntaxNode) HashSet[(int32, int32)] {
            let spans = HashSet[(int32, int32)]()
            for acc in FindDescendantNodes[AccessorExpressionSyntax](root) {
                for tok in EnumerateIndexedMemberTokensInAccessorRight(acc.RightPart) {
                    spans.Add((tok.Span.Start, tok.Span.End))
                }
            }
            for idx in FindDescendantNodes[IndexExpressionSyntax](root) {
                if idx.Target is AccessorExpressionSyntax directAcc {
                    for tok in EnumerateIndexedTargetLeafTokens(directAcc.RightPart) {
                        spans.Add((tok.Span.Start, tok.Span.End))
                    }
                }
            }
            return spans
        }

        private func EnumerateIndexedMemberTokensInAccessorRight(expr ExpressionSyntax) sequence[SyntaxToken] {
            switch expr {
                case idx is IndexExpressionSyntax {
                    for tok in EnumerateIndexedTargetLeafTokens(idx.Target) {
                        yield tok
                    }
                }
                case nested is AccessorExpressionSyntax {
                    for tok in EnumerateIndexedMemberTokensInAccessorRight(nested.LeftPart) {
                        yield tok
                    }
                    for tok in EnumerateIndexedMemberTokensInAccessorRight(nested.RightPart) {
                        yield tok
                    }
                }
            }
        }

        private func EnumerateIndexedTargetLeafTokens(target ExpressionSyntax) sequence[SyntaxToken] {
            switch target {
                case name is NameExpressionSyntax {
                    yield name.IdentifierToken
                }
                case genericName is GenericNameExpressionSyntax {
                    yield genericName.Identifier
                }
                case call is CallExpressionSyntax {
                    yield call.Identifier
                }
                case idx is IndexExpressionSyntax {
                    for tok in EnumerateIndexedTargetLeafTokens(idx.Target) {
                        yield tok
                    }
                }
                case acc is AccessorExpressionSyntax {
                    for tok in EnumerateIndexedTargetLeafTokens(acc.RightPart) {
                        yield tok
                    }
                }
            }
        }

        private func ClassifyTokenRole(tok SyntaxToken, indexedMemberSpans HashSet[(int32, int32)]) string {
            if indexedMemberSpans.Contains((tok.Span.Start, tok.Span.End)) {
                return "IndexedMemberAccess"
            }
            let parent = tok.Parent
            if parent == nil {
                return tok.Kind.ToString()
            }
            return switch parent {
                case s is StructDeclarationSyntax when object.ReferenceEquals(s.Identifier, tok): "StructDeclaration"
                case i is InterfaceDeclarationSyntax when object.ReferenceEquals(
                    i.Identifier,
                    tok
                ): "InterfaceDeclaration"
                case e is EnumDeclarationSyntax when object.ReferenceEquals(e.Identifier, tok): "EnumDeclaration"
                case em is EnumMemberSyntax when object.ReferenceEquals(em.Identifier, tok): "EnumMemberDeclaration"
                case f is FunctionDeclarationSyntax when object.ReferenceEquals(
                    f.Identifier,
                    tok
                ): "FunctionDeclaration"
                case p is PropertyDeclarationSyntax when object.ReferenceEquals(
                    p.Identifier,
                    tok
                ): "PropertyDeclaration"
                case fld is FieldDeclarationSyntax when object.ReferenceEquals(fld.Identifier, tok): "FieldDeclaration"
                case param is ParameterSyntax when object.ReferenceEquals(param.Identifier, tok): "ParameterDeclaration"
                case v is VariableDeclarationSyntax when object.ReferenceEquals(
                    v.Identifier,
                    tok
                ): "VariableDeclaration"
                case il is IfLetBindingClauseSyntax when object.ReferenceEquals(
                    il.Identifier,
                    tok
                ): "GuardOrIfLetDeclaration"
                case CallExpressionSyntax _: "CallExpression"
                case NameExpressionSyntax _: "NameExpression"
                case TypeClauseSyntax _: "TypeClause"
                default: parent.GetType().Name
            }
        }

        private func IsEligibleUnboundIdentifier(tok SyntaxToken) bool {
            let text = tok.Text
            if string.IsNullOrEmpty(text) || text == "_" {
                return false
            }
            if IsContextualKeywordOrBuiltinIdentifier(text) {
                return false
            }
            let parent = tok.Parent
            if parent is PackageSyntax or ImportSyntax or AnnotationSyntax {
                return false
            }
            if parent is NameExpressionSyntax &&
                parent.Parent is AccessorExpressionSyntax &&
                IsKnownNamespaceSegment(text) {
                return false
            }
            return true
        }

        private func IsContextualKeywordOrBuiltinIdentifier(text string) bool -> switch text {
            case "prop",
            "get",
            "set",
            "init",
            "in",
            "shared",
            "partial",
            "data",
            "open",
            "sealed",
            "override",
            "deinit",
            "event",
            "operator",
            "where",
            "when",
            "out",
            "ref",
            "params",
            "inline",
            "typeof",
            "nameof",
            "base",
            "uint8",
            "int8",
            "int16",
            "uint16",
            "int32",
            "uint32",
            "int64",
            "uint64",
            "float32",
            "float64",
            "decimal",
            "byte",
            "char",
            "string",
            "bool",
            "object",
            "void",
            "int",
            "uint",
            "nint",
            "nuint",
            "bytestring",
            "span",
            "slice",
            "map",
            "sequence": true
            default: false
        }

        private func IsKnownNamespaceSegment(text string) bool -> switch text {
            case "System",
            "Collections",
            "Generic",
            "Net",
            "Http",
            "Headers",
            "CodeDom",
            "Compiler",
            "Diagnostics",
            "CodeAnalysis",
            "ComponentModel": true
            default: false
        }

        private func IsPlaceholderTypeSignature(signature string) bool {
            return signature.EndsWith(" ?", StringComparison.Ordinal) || signature.Contains(
                " ? ",
                StringComparison.Ordinal
            )
        }

        private func ExtractSignature(hover Hover?) string {
            if hover == nil {
                return ""
            }
            let raw = hover.Contents.ToString()
            if raw.StartsWith("```gsharp\n", StringComparison.Ordinal) {
                let afterFence = raw.Substring("```gsharp\n".Length)
                let endFence = afterFence.IndexOf("\n```", StringComparison.Ordinal)
                if endFence >= 0 {
                    return afterFence.Substring(0, endFence)
                }
            }
            let lines = raw.Split('\n')
            return if lines.Length > 1 {
                lines[1]
            } else {
                raw
            }
        }

        private func RangesEqual(
            a GSharp.LanguageServer.Protocol.Range?,
            b GSharp.LanguageServer.Protocol.Range?
        ) bool {
            if a == nil && b == nil {
                return true
            }
            if a == nil || b == nil {
                return false
            }
            return a
                .Start
                .Line == b
                .Start
                .Line &&
                a
                .Start
                .Character == b
                .Start
                .Character &&
                a
                .End
                .Line == b
                .End
                .Line &&
                a
                .End
                .Character == b
                .End
                .Character
        }

        private func FormatRange(r GSharp.LanguageServer.Protocol.Range?) string {
            if r == nil {
                return "nil"
            }
            return "${r.Start.Line}:${r.Start.Character}-${r.End.Line}:${r.End.Character}"
        }

        private func GetDeclaredSymbolIfIdentifier(
            model GSharp.Core.CodeAnalysis.SemanticModel,
            tok SyntaxToken
        ) Symbol? {
            let parent = tok.Parent
            if parent == nil {
                return nil
            }
            let isDeclId = switch parent {
                case s is StructDeclarationSyntax: object.ReferenceEquals(s.Identifier, tok)
                case i is InterfaceDeclarationSyntax: object.ReferenceEquals(i.Identifier, tok)
                case e is EnumDeclarationSyntax: object.ReferenceEquals(e.Identifier, tok)
                case em is EnumMemberSyntax: object.ReferenceEquals(em.Identifier, tok)
                case d is DelegateDeclarationSyntax: object.ReferenceEquals(d.Identifier, tok)
                case ta is TypeAliasDeclarationSyntax: object.ReferenceEquals(ta.Identifier, tok)
                case f is FunctionDeclarationSyntax: object.ReferenceEquals(f.Identifier, tok)
                case p is PropertyDeclarationSyntax: object.ReferenceEquals(p.Identifier, tok)
                case fld is FieldDeclarationSyntax: object.ReferenceEquals(fld.Identifier, tok)
                case ev is EventDeclarationSyntax: object.ReferenceEquals(ev.Identifier, tok)
                case param is ParameterSyntax: object.ReferenceEquals(param.Identifier, tok)
                case v is VariableDeclarationSyntax: object.ReferenceEquals(v.Identifier, tok)
                case il is IfLetBindingClauseSyntax: object.ReferenceEquals(il.Identifier, tok)
                default: false
            }
            return if isDeclId {
                model.GetDeclaredSymbol(parent)
            } else {
                default(Symbol?)
            }
        }

        private func ExpectedOracleSignature(symbol Symbol, compilation Compilation, tok SyntaxToken) string {
            if BoundSemantics.IsImportedMember(symbol) && SemanticLookup.ResolveSymbol(compilation, tok) == nil &&
                BoundSemantics.GetMemberInfo(symbol) is {} memberInfo {
                return switch memberInfo {
                    case propInfo is PropertyInfo: SymbolDisplay.ToDisplayString(propInfo, SymbolDisplayFormat.Hover)
                    case fieldInfo is FieldInfo: SymbolDisplay.ToDisplayString(fieldInfo, SymbolDisplayFormat.Hover)
                    case eventInfo is EventInfo: SymbolDisplay.ToDisplayString(eventInfo, SymbolDisplayFormat.Hover)
                    case methodInfo is MethodInfo: SymbolDisplay.ToDisplayString(methodInfo, SymbolDisplayFormat.Hover)
                    case ctorInfo is ConstructorInfo: SymbolDisplay.ToDisplayString(ctorInfo, SymbolDisplayFormat.Hover)
                    default: SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Hover, compilation)
                }
            }
            return SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Hover, compilation)
        }

        private func IsSyntheticTokenHitLeak(source SourceText, hit SyntaxToken?) bool {
            if hit == nil || IsPhysicalToken(source, hit) {
                return false
            }
            if hit.Span.Start >= 0 && hit.Span.Length == 2 && hit.Span.End <= source.Length {
                let raw = source.ToString(hit.Span)
                if (hit.Kind == SyntaxKind.PlusEqualsToken && raw == "++") ||
                    (hit.Kind == SyntaxKind.MinusEqualsToken && raw == "--") {
                    return false
                }
            }
            return true
        }

        private func IsPhysicalToken(source SourceText, token SyntaxToken) bool {
            if token.IsMissing || token.Kind == SyntaxKind.EndOfFileToken {
                return false
            }
            if token.Span.Start < 0 || token.Span.Length <= 0 || token.Span.End > source.Length {
                return false
            }
            let text = token.Text
            if string.IsNullOrEmpty(text) || token.Span.Length != text.Length {
                return false
            }
            return string.Equals(source.ToString(token.Span), text, StringComparison.Ordinal)
        }

        private func EnumerateTreeTokens(node SyntaxNode) sequence[SyntaxToken] {
            if node is SyntaxToken token {
                yield token
                yield break
            }
            for child in node.GetChildren() {
                for childToken in EnumerateTreeTokens(child) {
                    yield childToken
                }
            }
        }

        private func FindDescendantNodes[T SyntaxNode](node SyntaxNode) sequence[T] {
            if node is T matched {
                yield matched
            }
            for child in node.GetChildren() {
                for desc in FindDescendantNodes[T](child) {
                    yield desc
                }
            }
        }

        private func BuildLineOffsets(source string) List[int32] {
            let lines = List[int32]()
            for var i = 0; i < source.Length; i++ {
                if source[i] == '\n' {
                    lines.Add(i)
                }
            }
            return lines
        }

        private func NormalizeRelativePath(root string, fullPath string) string {
            return Path.GetRelativePath(root, fullPath).Replace('\\', '/')
        }

        private func RuntimeOperatingSystemName() string {
            return if OperatingSystem.IsWindows() {
                "windows"
            } else if OperatingSystem.IsMacOS() {
                "macos"
            } else {
                "linux"
            }
        }

        private func LocateLanguageServerDll() string {
            let candidate = Path.Combine(AppContext.BaseDirectory, "GSharp.LanguageServer.dll")
            if File.Exists(candidate) {
                return candidate
            }
            let repoCandidate = Path.Combine(
                Directory.GetCurrentDirectory(),
                "out",
                "bin",
                "Release",
                "LanguageServer",
                "GSharp.LanguageServer.dll"
            )
            Assert.True(File.Exists(repoCandidate), "Could not locate built GSharp.LanguageServer.dll.")
            return repoCandidate
        }

        private async func WriteLspFrameAsync(stream Stream, payload string) {
            let body = Encoding.UTF8.GetBytes(payload)
            let header = Encoding.ASCII.GetBytes("Content-Length: ${body.Length}\r\n\r\n")
            await stream.WriteAsync(header, 0, header.Length)
            await stream.WriteAsync(body, 0, body.Length)
            await stream.FlushAsync()
        }

        private async func ReadLspResponseForIdAsync(stream Stream, expectedId int32, timeout TimeSpan) string {
            using let cts = CancellationTokenSource(timeout)
            while true {
                let frame = await ReadLspFrameAsync(stream, cts.Token)
                using let doc = JsonDocument.Parse(frame)
                if doc.RootElement.TryGetProperty("id", out var idProp) &&
                    idProp.ValueKind == JsonValueKind.Number &&
                    idProp.GetInt32() == expectedId {
                    return frame
                }
            }
        }

        private async func ReadLspFrameAsync(stream Stream, ct CancellationToken) string {
            let headerBytes = List[uint8]()
            let one = [1]uint8
            while true {
                let n = await stream.ReadAsync(one, 0, 1, ct)
                Assert.True(n == 1, "Unexpected EOF while reading LSP frame header.")
                headerBytes.Add(one[0])
                let count = headerBytes.Count
                if count >= 4 &&
                    headerBytes[count - 4] == uint8('\r') &&
                    headerBytes[count - 3] == uint8('\n') &&
                    headerBytes[count - 2] == uint8('\r') &&
                    headerBytes[count - 1] == uint8('\n') {
                    break
                }
            }
            let headerText = Encoding.ASCII.GetString(headerBytes.ToArray())
            var contentLength = 0
            for line in headerText.Split([]string{"\r\n"}, StringSplitOptions.RemoveEmptyEntries) {
                if line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase) {
                    contentLength = int32.Parse(
                        line.Substring("Content-Length:".Length).Trim(),
                        CultureInfo.InvariantCulture
                    )
                }
            }
            Assert.True(contentLength > 0, "Invalid Content-Length in LSP header.")
            let body = [contentLength]uint8
            var offset = 0
            while offset < contentLength {
                let read = await stream.ReadAsync(body, offset, contentLength - offset, ct)
                Assert.True(read > 0, "Unexpected EOF while reading LSP frame body.")
                offset += read
            }
            return Encoding.UTF8.GetString(body)
        }

        private func WriteAuditArtifacts(
            artifactsDir string,
            summary WorkspaceAuditSummary,
            files IReadOnlyList[FileInventorySummary],
            failures IReadOnlyList[AuditFailureRecord]
        ) {
            Directory.CreateDirectory(artifactsDir)
            let options = JsonSerializerOptions{WriteIndented: true}
            File.WriteAllText(Path.Combine(artifactsDir, "summary.json"), JsonSerializer.Serialize(summary, options))
            File.WriteAllText(Path.Combine(artifactsDir, "inventory.json"), JsonSerializer.Serialize(files, options))
            File.WriteAllText(Path.Combine(artifactsDir, "failures.json"), JsonSerializer.Serialize(failures, options))

            let csv = StringBuilder()
            csv.AppendLine("target_id,role,kind,issue,unreviewed,expected,actual")
            for f in failures {
                csv
                    .Append(EscapeCsv(f.TargetId))
                    .Append(',')
                    .Append(EscapeCsv(f.Role))
                    .Append(',')
                    .Append(EscapeCsv(f.Kind))
                    .Append(',')
                    .Append(EscapeCsv(f.Issue))
                    .Append(',')
                    .Append(
                    if f.IsUnreviewed {
                        "true"
                    } else {
                        "false"
                    }
                )
                    .Append(',')
                    .Append(EscapeCsv(f.Expected))
                    .Append(',')
                    .AppendLine(EscapeCsv(f.Actual))
            }
            File.WriteAllText(Path.Combine(artifactsDir, "failures.csv"), csv.ToString())

            let md = StringBuilder()
            md.AppendLine("## Waikiki Headless Hover Audit")
            md.AppendLine()
            md.AppendLine("| Metric | Value |")
            md.AppendLine("| --- | --- |")
            md.AppendLine("| Corpus commit | `${summary.CorpusCommit}` |")
            md.AppendLine("| Corpus SDK pin | `${summary.SdkVersion}` |")
            md.AppendLine("| OS | `${summary.OperatingSystemName}` |")
            md.AppendLine("| Discovered projects | ${summary.ProjectCount} |")
            md.AppendLine("| Authored `.gs` files | ${summary.AuthoredFileCount} |")
            md.AppendLine("| Generated `gsgen` `.g.gs` files | ${summary.GeneratedFileCount} |")
            md.AppendLine("| Physical source tokens | ${summary.PhysicalTokenCount} |")
            md.AppendLine("| Start + interior hover checks | ${summary.StartAndInteriorCheckCount} |")
            md.AppendLine("| Excluded synthetic parser tokens | ${summary.ExcludedSyntheticTokenCount} |")
            md.AppendLine("| Synthetic token hit-testing leaks | ${summary.SyntheticLeakCount} |")
            md.AppendLine("| Compiler-oracle symbol targets | ${summary.CompilerOracleTargetCount} |")
            md.AppendLine("| Compiler-oracle exact matches | ${summary.CompilerOracleMatchedCount} |")
            md.AppendLine("| Non-null hovers | ${summary.HoverNonNullCount} |")
            md.AppendLine("| Placeholder `?` hovers | ${summary.PlaceholderHoverCount} |")
            md.AppendLine("| Interior hover mismatches | ${summary.InteriorMismatchCount} |")
            md.AppendLine("| Reviewed issue-linked failures (`#5899`) | ${summary.ReviewedFailureCount} |")
            md.AppendLine(
                "| Reviewed issue-linked syntax gaps (`#5900`, `#5904`) | ${summary.ReviewedSyntaxGapCount} |"
            )
            md.AppendLine("| Unreviewed failures | ${summary.UnreviewedFailureCount} |")
            md.AppendLine("| Stale reviewed expectations | ${summary.StaleExpectationCount} |")
            md.AppendLine("| Elapsed (ms) | ${summary.ElapsedMilliseconds} |")
            File.WriteAllText(Path.Combine(artifactsDir, "summary.md"), md.ToString())
        }

        private func EscapeCsv(value string) string {
            let escaped = (value ?? string.Empty).Replace("\"", "\"\"", StringComparison.Ordinal)
            return "\"$escaped\""
        }
    }
}

internal data class AuditEmptyRpcParams() { }

internal data class ReviewedFailure(
    TargetId string,
    Issue string,
    Kind string,
    Expected string,
    Actual string
) : IEquatable[ReviewedFailure] { }

internal data class AuditFailureRecord(
    TargetId string,
    Role string,
    Kind string,
    Issue string,
    IsUnreviewed bool,
    Expected string,
    Actual string
) : IEquatable[AuditFailureRecord] { }

internal data class FileInventorySummary(
    RelativePath string,
    Sha256 string,
    IsGenerated bool,
    PhysicalTokens int32,
    Checks int32,
    OracleTargets int32,
    HoverCount int32
) : IEquatable[FileInventorySummary] { }

internal data class WorkspaceAuditSummary(
    CorpusCommit string,
    SdkVersion string,
    OperatingSystemName string,
    ProjectCount int32,
    AuthoredFileCount int32,
    GeneratedFileCount int32,
    PhysicalTokenCount int32,
    StartAndInteriorCheckCount int32,
    ExcludedSyntheticTokenCount int32,
    SyntheticLeakCount int32,
    CompilerOracleTargetCount int32,
    CompilerOracleMatchedCount int32,
    HoverNonNullCount int32,
    PlaceholderHoverCount int32,
    InteriorMismatchCount int32,
    ReviewedFailureCount int32,
    ReviewedSyntaxGapCount int32,
    UnreviewedFailureCount int32,
    StaleExpectationCount int32,
    ElapsedMilliseconds int64
) : IEquatable[WorkspaceAuditSummary] { }
