// <copyright file="Issue4681ChannelsNullPassThroughTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// Issue #4681: the channels runtime wrote `value!` on unconstrained
/// `T` values. That is a compile-time no-op in C#, but cs2gs translates it
/// to a fail-fast `!!`, so the migrated runtime threw a
/// `NullReferenceException` on `ch <- nil; <-ch` for
/// `chan[string?]` and in `select` send arms (the #4612 class: a
/// maybe-null value of an unconstrained type parameter hits a throwing
/// assertion). The C# is written so no null-forgiving operator touches an
/// element value; this test migrates the real runtime sources and rejects any
/// `!!` on one.
open class Issue4681ChannelsNullPassThroughTests {
    /// The discriminating witness (ADR-0154): migrate every source file of the
    /// real runtime project, exactly as the self-migration does, and reject a
    /// fail-fast bridge on an element value. It fails on the pre-fix sources
    /// (five sites that survive the polish pass, plus the ones it strips).
    @Fact
    async func ChannelsRuntimeSelfMigration_NeverAssertsAnElementValue() {
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        let project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "src", "Sdk", "Gsharp.Runtime.Channels", "Gsharp.Runtime.Channels.csproj")
        )
        Assert.True(
            project.BoundWithoutErrors,
            "Gsharp.Runtime.Channels should bind with no C# errors: " + string.Join(
                Environment.NewLine,
                project.ErrorDiagnostics
            )
        )
        let offending = List[string]()
        var sawChanCore = false
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            var printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(document, context)
            )
            let name = Path.GetFileName(document.FilePath)
            sawChanCore |= name == "Chan{T}.cs"
            printed = BlockComment.Replace(printed, string.Empty)
            for raw in printed.Split('\n') {
                let line = raw.Trim()
                if line.StartsWith("//", StringComparison.Ordinal) || line.StartsWith("///", StringComparison.Ordinal) {
                    continue
                }
                if ElementValueAssertion.IsMatch(line) {
                    offending.Add(name + ": " + line)
                }
            }
        }
        Assert.True(sawChanCore, "The channels runtime should include Chan{T}.cs.")
        Assert.True(
            offending.Count == 0,
            "A fail-fast `!!` on a channel element value throws on `nil` in the migrated runtime:" +
                Environment.NewLine +
                string.Join(Environment.NewLine, offending)
        )
    }

    /// Issue #4702: the nil-element runtime tests themselves must migrate to
    /// G# that gsc accepts. Reading a named element off an awaited tuple
    /// (`tuple.Value`) and comparing a `(nil, true)` literal against a
    /// `(string?, bool)` tuple both failed to compile (GS0158, GS0155), and deconstructing the
    /// imported tuple failed too (GS0164), so the tests read `Item1`/`Item2`. The migration compile of
    /// `test/Runtime.Channels.Tests` is the full gate; this pins the shapes.
    @Fact
    async func NilElementTests_MigrateWithoutTupleMemberReadsOrNilTupleLiterals() {
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        let project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "test", "Runtime.Channels.Tests", "Runtime.Channels.Tests.csproj")
        )
        let document = Enumerable.Single(
            project.Documents,
            (candidate LoadedDocument) -> Path.GetFileName(candidate.FilePath) == "Issue4681NilElementTests.cs"
        )
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(document, context)
        )
        Assert.Contains("BufferedNil_RoundTripsThroughEveryReceiveShape", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("(nil, true)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("tuple.Value", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("tuple.Ok", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let (element, delivered)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let (received, receivedOk)", printed, StringComparison.Ordinal)
    }

    shared {
        // The element values the runtime moves, by every name it moves them under:
        // locals and fields (value, taken, sendValue, received, pending), a
        // ReceiveResult's Value, and the zero value of T / TResult.
        private let BlockComment Regex = Regex("/\\*.*?\\*/", RegexOptions.Compiled | RegexOptions.Singleline)

        private let ElementValueAssertion Regex = Regex(
            "(?:(?<![\\w])(?:this\\.)?(?:value|taken|sendValue|received|pending|item)|\\.Value|(?<![\\w])default\\(T\\w*\\))!!",
            RegexOptions.Compiled
        )
    }
}
