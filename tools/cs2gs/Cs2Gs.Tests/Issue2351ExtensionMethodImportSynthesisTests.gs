// <copyright file="Issue2351ExtensionMethodImportSynthesisTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #2351: (cref:CSharpTypeMapper.TrackShortenedNamespace) records the
/// namespace of every TYPE reference the translator shortens (issue #2211), so a
/// missing `using` for a shortened type name synthesizes a matching
/// `import`. An extension-method CALL SITE (`key.All(...)`) names no
/// type at all — neither `Enumerable` nor `System.Linq` appear in its
/// syntax — so that tracking never observed it. A C# file that reaches the
/// extension only through an IMPLICIT `using` (SDK `ImplicitUsings`
/// global usings, or a hand-authored `GlobalUsings.cs`, or a namespace-less
/// source-generator file per ADR-0145) previously round-tripped to G# with the
/// call intact but NO import for its owning namespace at all — unresolvable
/// output (GS0159), exactly the shape observed in Oahu.Diagnostics'
/// `ExportCheck.Run` (`key.All(char.IsAsciiHexDigit)`, whose project
/// enables `ImplicitUsings` and has no explicit `using System.Linq;`).
///
/// The fix ((cref:CSharpTypeMapper.TrackExtensionMethodNamespace)) records
/// the declaring namespace of any RESOLVED extension method — whether reached via
/// an invocation ((cref:Cs2Gs.Translator.CSharpToGSharpTranslator)'s
/// `TranslateInvocation`, covering the reduced instance form, the unreduced
/// static form, and the bare-sibling-static form) or via a bare, non-invoked
/// method-group reference (`TranslateMemberAccess`) — into the SAME
/// (cref:CSharpTypeMapper.ShortenedNamespaces) set that issue #2211's fix
/// already drains into synthesized imports, so the existing
/// dedup-against-explicit-usings and skip-own-package logic in
/// `CSharpToGSharpTranslator.TranslateDocument` applies uniformly with no
/// separate code path.
open class Issue2351ExtensionMethodImportSynthesisTests {
    @Fact
    func RealOahuExportCheckShape_ImplicitLinqUsing_SynthesizesImportAndCompilesEndToEnd() {
        // Mirrors the exact reported shape: Oahu.Diagnostics' ExportCheck.cs has
        // NO `using System.Linq;` of its own (ImplicitUsings supplies it via a
        // separate, SDK-generated GlobalUsings.g.cs file) and calls the bare
        // method-group form `key.All(char.IsAsciiHexDigit)`. Now that issue
        // #2347 (imported/BCL method-group-to-delegate inference across
        // generic extension methods) is fixed, this exact shape compiles
        // end-to-end with the real gsc, proving the import synthesized by
        // THIS fix is sufficient on its own for the call to resolve.
        let printed = TranslateNamed("ExportCheck.cs", ("ExportCheck.cs", `
namespace Oahu.Diagnostics.Checks
{
    public static class ExportCheck
    {
        public static bool CheckKeyFormat(string key)
        {
            return key.Length == 32 && key.All(char.IsAsciiHexDigit);
        }
    }
}`), ("GlobalUsings.g.cs", "global using System.Linq;\n"))
        Assert.Equal(1, CountOccurrences(printed, "import System.Linq"))
        Assert.Contains("key.All(", printed)
        AssertCompiles(printed)
    }

    @Fact
    func LambdaEquivalentShape_MissingLinqUsing_SynthesizesImportAndCompilesEndToEnd() {
        // Same missing-using shape as the Oahu repro, but with an equivalent
        // lambda predicate instead of the bare method-group form. Kept
        // alongside the bare-method-group end-to-end test above to prove the
        // import-synthesis fix is independently sufficient regardless of
        // which predicate spelling is used.
        let printed = TranslateNamed("Checker.cs", ("Checker.cs", `
namespace Demo
{
    public static class Checker
    {
        public static bool AllDigits(string key)
        {
            return key.All(c => char.IsAsciiHexDigit(c));
        }
    }
}`), ("GlobalUsings.g.cs", "global using System.Linq;\n"))
        Assert.Equal(1, CountOccurrences(printed, "import System.Linq"))
        AssertCompiles(printed)
    }

    @Fact
    func ExplicitUsingAlreadyPresent_NoDuplicateImportSynthesized() {
        // Control: an explicit `using System.Linq;` already covers the call, so
        // no duplicate is synthesized alongside the ordinary explicit import.
        let printed = TranslateUnit(`
using System.Linq;

namespace Demo
{
    public static class Checker
    {
        public static bool AllDigits(string key)
        {
            return key.All(char.IsAsciiHexDigit);
        }
    }
}`)
        Assert.Equal(1, CountOccurrences(printed, "import System.Linq"))
    }

    @Fact
    func CustomExtensionNamespace_DifferentNamespaceSameCompilation_SynthesizesImport() {
        // A custom (source-defined, non-BCL) extension method declared in a
        // DIFFERENT namespace than its call site, reached only through a
        // hand-authored global-using file (the same shape a repo's own
        // `GlobalUsings.cs` takes) rather than a per-file `using` — proves the
        // fix generalizes beyond BCL/System.Linq to any imported (same-
        // compilation, different-namespace) extension.
        let printed = TranslateNamedRoundTripOnly(
            "Consumer.cs",
            "Target-only fixture omits the source extension declaration needed to bind the imported call.",
            ("Extensions.cs", `
namespace Acme.Extensions
{
    public static class StringChecks
    {
        public static bool IsFoo(this string s) { return s == "foo"; }
    }
}`),
            ("Consumer.cs", `
namespace Acme.App
{
    public class Consumer
    {
        public bool Check(string s)
        {
            return s.IsFoo();
        }
    }
}`),
            ("GlobalUsings.g.cs", "global using Acme.Extensions;\n")
        )
        Assert.Equal(1, CountOccurrences(printed, "import Acme.Extensions"))
        Assert.Contains("s.IsFoo()", printed)
    }

    @Fact
    func CustomExtensionNamespace_SameNamespaceAsCallSite_NoSpuriousOwnPackageImport() {
        // Control: a custom extension declared in the SAME namespace as its
        // call site needs no import at all — the existing own-package filter
        // in `CSharpToGSharpTranslator.TranslateDocument` (`ns != package`)
        // must still suppress a self-import once extension namespaces flow
        // through the same tracked set.
        let printed = TranslateUnit(`
namespace Acme.App
{
    public static class StringChecks
    {
        public static bool IsFoo(this string s) { return s == "foo"; }
    }

    public class Consumer
    {
        public bool Check(string s)
        {
            return s.IsFoo();
        }
    }
}`)
        Assert.DoesNotContain("import Acme.App", printed)
    }

    @Fact
    func NestedNamespaceCustomExtension_SynthesizesImport() {
        // A custom extension declared in a multi-segment nested namespace,
        // reached through a global using rather than a per-file `using`.
        let printed = TranslateNamedRoundTripOnly(
            "Consumer.cs",
            "Target-only fixture omits the source extension declaration needed to bind the imported call.",
            ("Extensions.cs", `
namespace Acme.Deep.Nested.Extensions
{
    public static class NumberChecks
    {
        public static bool IsPositive(this int n) { return n > 0; }
    }
}`),
            ("Consumer.cs", `
namespace Acme.App
{
    public class Consumer
    {
        public bool Check(int n)
        {
            return n.IsPositive();
        }
    }
}`),
            ("GlobalUsings.g.cs", "global using Acme.Deep.Nested.Extensions;\n")
        )
        Assert.Equal(1, CountOccurrences(printed, "import Acme.Deep.Nested.Extensions"))
    }

    @Fact
    func BareMethodGroupReference_NonInvokedExtension_SynthesizesImport() {
        // A bare (non-invoked) reference to an extension method — assigned to a
        // delegate rather than called directly — is not an
        // InvocationExpressionSyntax at all, so it only reaches the translator
        // through TranslateMemberAccess, never TranslateInvocation. Exercises
        // that second tracking call site.
        let printed = TranslateNamed("Consumer.cs", ("Consumer.cs", `
using System.Collections.Generic;

namespace Demo
{
    public class Consumer
    {
        public int CountOf(IEnumerable<int> seq)
        {
            System.Func<int> counter = seq.Count;
            return counter();
        }
    }
}`), ("GlobalUsings.g.cs", "global using System.Linq;\n"))
        Assert.Equal(1, CountOccurrences(printed, "import System.Linq"))
    }

    @Fact
    func AliasedStaticFormCustomExtension_SynthesizesRealNamespaceImport_NotAliasName() {
        // A custom extension called through its unreduced static form via a
        // TYPE alias (`using SC = Acme.Extensions.StringChecks;`). The C#
        // `using SC = ...;` alias itself is preserved as its own explicit
        // `import SC = Acme.Extensions.StringChecks` (pre-existing,
        // unrelated behavior) — but that alias entry does NOT satisfy the
        // dedup check for the REAL namespace `Acme.Extensions`, since the
        // bound extension-method symbol resolves identically regardless of
        // the alias spelling: the real namespace must still be imported in
        // its own right for the call to resolve.
        // The extension and its consumer must live in SEPARATE files/namespaces
        // (rather than two `namespace` blocks in one file) since the translator
        // merges multiple same-file namespaces into one dominant package,
        // which would make them share a package and hide the cross-namespace
        // import requirement this test targets.
        let printed = TranslateNamedRoundTripOnly(
            "Consumer.cs",
            "Target-only fixture omits the source extension declaration needed to bind the imported call.",
            ("Extensions.cs", `
namespace Acme.Extensions
{
    public static class StringChecks
    {
        public static bool IsFoo(this string s) { return s == "foo"; }
    }
}`),
            ("Consumer.cs", `
namespace Acme.App
{
    using SC = Acme.Extensions.StringChecks;

    public class Consumer
    {
        public bool Check(string s)
        {
            return SC.IsFoo(s);
        }
    }
}`)
        )
        Assert.Equal(1, CountOccurrences(printed, "import Acme.Extensions"))
    }

    shared {
        private func TranslateUnit(source string) string {
            return TranslateNamed("Snippet.cs", ("Snippet.cs", source))
        }

        private func TranslateNamedRoundTripOnly(
            targetFileName string,
            reason string,
            sources ...(FileName string, Source string)
        ) string {
            return TranslateNamed(targetFileName, reason, sources)
        }

        private func TranslateNamed(targetFileName string, sources ...(FileName string, Source string)) string {
            return TranslateNamed(targetFileName, roundTripOnlyReason: nil, sources)
        }

        private func TranslateNamed(
            targetFileName string,
            roundTripOnlyReason string?,
            sources ...(FileName string, Source string)
        ) string {
            let project = CSharpProjectLoader.LoadInMemory(sources)
            Assert.True(
                project.BoundWithoutErrors,
                "Inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents, (d LoadedDocument) -> d.FilePath == targetFileName)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        /// Compiles [`printed`](paramref) with the real `gsc` and asserts
        /// zero errors — proving the synthesized import actually resolves the call,
        /// not just that the printed text looks right.
        private func AssertCompiles(printed string, extraReferences ...string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2351-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed)
            let refArgs = string.Concat(extraReferences.Select((r string) -> " /r:\"$r\""))
            let (compileExit, compileOut) = RunDotnet(
                "\"$compiler\" /target:library$refArgs /out:\"$dllPath\" \"$gsPath\""
            )
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            // Read stdout/stderr concurrently to avoid a classic pipe deadlock: reading
            // one stream fully before starting the other can hang forever if the
            // child fills the OS pipe buffer on the stream not yet read.
            let stdoutTask = process!!.StandardOutput.ReadToEndAsync()
            let stderrTask = process!!.StandardError.ReadToEndAsync()
            Task.WaitAll(stdoutTask, stderrTask)
            process!!.WaitForExit()
            return (process!!.ExitCode, stdoutTask.Result + stderrTask.Result)
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }

        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            var index = 0
            while (index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += needle.Length
            }
            return count
        }
    }
}
