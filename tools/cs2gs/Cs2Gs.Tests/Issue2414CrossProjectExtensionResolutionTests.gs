// <copyright file="Issue2414CrossProjectExtensionResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// End-to-end regression tests for issue #2414, using the minimal
/// two-/three-project corpus the issue calls for: project "Foundation"
/// declares a non-generic and a generic extension method (mirroring the real
/// Oahu.Foundation `ExNullable.IsNullOrEmpty(this string)` /
/// `IsNullOrEmpty<T>(this IEnumerable<T>)` shape exactly);
/// project "Core" declares its OWN colliding same-simple-name extension on an
/// unrelated receiver type (mirroring Oahu.Core's own
/// `IsNullOrEmpty(this HttpHeaders)`) and consumes Foundation's
/// extensions via BOTH instance (`x.IsNullOrEmpty()`) and static
/// (`ExNullable.IsNullOrEmpty(x)`) call syntax, with a nullable receiver
/// and with generic type inference; project "App" transitively references
/// Core (and therefore Foundation) and is a genuinely NEUTRAL package with no
/// colliding declaration of its own, exercising transitive cross-project
/// resolution from a caller that owns neither the plain bucket nor any
/// qualified bucket.
///
/// Every project here is translated by the real (cref:CSharpToGSharpTranslator)
/// and every assertion in (cref:Corpus_TranslatesAndCompilesAndRunsWithCorrectResolution)
/// is proven by actually compiling the merged multi-package output with the
/// real `gsc` (matching the `--no-via-sdk` pipeline's single-compilation
/// merge of app + every sibling project — see `CompileStage`) and running
/// the resulting program, so the test exercises the exact
/// (cref:GSharp.Core.CodeAnalysis.Binding.BoundScope) machinery that
/// silently mis-resolved (or failed to resolve) the real Oahu.Core migration.
open class Issue2414CrossProjectExtensionResolutionTests {
    @Fact
    func Corpus_TranslatesAndCompilesAndRunsWithCorrectResolution() {
        let foundation = LoadWithReferences(FoundationSource, "Foundation", nil)
        let core = LoadWithReferences(
            CoreSource,
            "Core",
            []MetadataReference{foundation.Compilation.ToMetadataReference()}
        )
        let app = LoadWithReferences(
            AppSource,
            "App",
            []MetadataReference{foundation.Compilation.ToMetadataReference(), core.Compilation.ToMetadataReference()}
        )
        let siblings = []CSharpCompilation{app.Compilation, core.Compilation, foundation.Compilation}
        let printedFoundation = TranslateProject(foundation, siblings)
        let printedCore = TranslateProject(core, siblings)
        let printedApp = TranslateProject(app, siblings)
        // ---- Translation-shape assertions -----------------------------------
        Assert.Contains("package Oahu.Aux.Extensions", printedFoundation)
        Assert.Contains("func (s string) IsNullOrEmpty() bool", printedFoundation)
        Assert.Contains("IsNullOrEmpty", printedFoundation)
        Assert.Contains("package Oahu.Core", printedCore)
        Assert.Contains("func (headers HttpHeadersLike?) IsNullOrEmpty() bool", printedCore)
        // Both instance AND static (unreduced) C# call forms must translate
        // to the SAME G# receiver-clause call shape (issue #914) — cs2gs has
        // no separate "static form" for extension calls in G#.
        Assert.Contains("s.IsNullOrEmpty()", Compact(printedCore))
        Assert.DoesNotContain("ExNullable.IsNullOrEmpty", printedCore)
        Assert.Contains("series.IsNullOrEmpty()", Compact(printedCore))
        Assert.Contains("headers.IsNullOrEmpty()", Compact(printedCore))
        Assert.Contains("package Oahu.App", printedApp)
        Assert.Contains("IsNullOrEmpty()", Compact(printedApp))
        // ---- The proof that matters: real gsc must compile the THREE
        // packages together (mirroring the --no-via-sdk single-compilation
        // merge) with zero errors, and running it must resolve every call
        // correctly instead of failing with GS0159 or resolving the wrong
        // overload. ---------------------------------------------------------
        let stdout = CompileAndRun(
            ("Foundation.gs", printedFoundation),
            ("Core.gs", printedCore),
            ("App.gs", printedApp)
        )
        let lines = stdout
            .ReplaceLineEndings(Environment.NewLine)
            .Trim(Environment.NewLine.ToCharArray())
            .Split(Environment.NewLine)
        Assert.Equal([]string{"True", "False", "True", "False", "False"}, lines)
    }

    shared {
        private const FoundationSource string = `
namespace Oahu.Aux.Extensions
{
    public static class ExNullable
    {
        public static bool IsNullOrEmpty(this string s) => string.IsNullOrEmpty(s);

        public static bool IsNullOrEmpty<T>(this System.Collections.Generic.IEnumerable<T> seq)
        {
            if (seq == null)
            {
                return true;
            }

            foreach (var _ in seq)
            {
                return false;
            }

            return true;
        }
    }
}`

        private const CoreSource string = (`
using Oahu.Aux.Extensions;

namespace Oahu.Core
{
    public sealed class HttpHeadersLike
    {
    }

    public static class CoreExtensions
    {
        // The exact real-world collision: Core declares its OWN extension
        // under the SAME simple name ("IsNullOrEmpty") on a receiver type
        // it owns, unrelated to Foundation's string/IEnumerable<T> overloads.
        public static bool IsNullOrEmpty(this HttpHeadersLike headers) => headers is null;
    }

    public sealed class BookLibrary
    {
        // Instance call syntax, nullable string receiver.
        public bool CheckStringInstance(string s) => s.IsNullOrEmpty();

        // Static (unreduced) call syntax for the SAME non-generic overload.
        public bool CheckStringStatic(string s) => ExNullable.IsNullOrEmpty(s);

        // Instance call syntax with generic inference over a user-visible
        // BCL sequence type (the real Oahu shape: ` + "`" + `book.Series.IsNullOrEmpty()` + "`" + `
        // where ` + "`" + `Series` + "`" + ` is ` + "`" + `ICollection<SeriesBook>` + "`" + `).
        public bool CheckSeriesInstance(System.Collections.Generic.List<int> series) => series.IsNullOrEmpty();

        // Static call syntax for the generic overload.
        public bool CheckSeriesStatic(System.Collections.Generic.List<int> series) => ExNullable.IsNullOrEmpty(series);

        // Own-package overload resolution must remain unaffected: Core's own
        // colliding extension must still resolve for its own receiver type.
        public bool CheckOwnHeaders(HttpHeadersLike headers) => headers.IsNullOrEmpty();
    }
}`)

        private const AppSource string = (`
using System;
using Oahu.Aux.Extensions;
using Oahu.Core;

namespace Oahu.App
{
    // A genuinely NEUTRAL third package: it does not declare its own
    // "IsNullOrEmpty" extension at all, and it transitively references
    // Core (and therefore Foundation) rather than referencing Foundation
    // directly, matching the "project C tests transitive reference
    // behavior" corpus shape from the issue.
    public sealed class Program
    {
        public static bool CheckTransitiveString(string s) => s.IsNullOrEmpty();

        public static bool CheckTransitiveSequence(System.Collections.Generic.List<int> items) => items.IsNullOrEmpty();

        // A neutral third package resolving the SAME simple name to Core's
        // OWN colliding extension when the receiver type actually matches
        // Core's — proving disambiguation-by-receiver-type works correctly
        // even from a caller that owns neither the plain bucket nor any
        // qualified bucket.
        public static bool CheckTransitiveHeaders(HttpHeadersLike headers) => headers.IsNullOrEmpty();

        public static void Main()
        {
            // Nullable-receiver coverage (declared-type level) is exercised
            // structurally: Core's own colliding extension ends up with a
            // nullable-typed receiver in translation (its body performs an
            // ` + "`" + `is null` + "`" + ` check), and Foundation's string/IEnumerable<T>
            // overloads accept nullable receivers by design. Runtime null
            // VALUES through this cross-project translated path are covered
            // instead by the pure-G#-source BoundScope unit tests
            // (Issue2414CrossPackageExtensionVisibilityTests), which are not
            // subject to cs2gs's separate oblivious-receiver ` + "`" + `!!` + "`" + ` assertion
            // heuristic — see the isolated next-blocker note in the PR
            // description for the runtime mismatch that heuristic causes
            // when a nullable-oblivious extension receiver is populated from
            // a tainted-nullable local/parameter across this translation
            // pipeline (independent of, and not fixed by, #2414).
            Console.WriteLine(CheckTransitiveString(""));
            Console.WriteLine(CheckTransitiveString("hi"));
            Console.WriteLine(CheckTransitiveSequence(new System.Collections.Generic.List<int>()));
            Console.WriteLine(CheckTransitiveSequence(new System.Collections.Generic.List<int> { 1 }));
            Console.WriteLine(CheckTransitiveHeaders(new HttpHeadersLike()));
        }
    }
}`)

        // ---- Helpers ---------------------------------------------------------
        private func LoadWithReferences(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]?
        ) LoadedCSharpProject {
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){(assemblyName + ".cs", source)},
                references,
                assemblyName
            )
            Assert.True(
                project.BoundWithoutErrors,
                "$assemblyName should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            return project
        }

        private func TranslateProject(
            project LoadedCSharpProject,
            siblingCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let translator = CSharpToGSharpTranslator()
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblingCompilations
            )
            let unit = translator.TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "CompileAndRun binds all three emitted packages together after per-project parse checks."
            )
            Assert.True(result.Success, "Translated G# must round-trip. Errors:\n" + string.Join("\n", result.Errors) + `

Printed:
` + printed)
            return printed
        }

        private func CompileAndRun(files ...(FileName string, Contents string)) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2414-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPaths = List[string]()
            for (fileName, contents) in files {
                gsPaths.Add(WriteFile(workDir, fileName, contents))
            }
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            let quotedSources = string.Join(" ", gsPaths.ConvertAll((p string) -> "\"$p\""))
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" $quotedSources")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated files together with zero errors. Output:\n" + compileOut
            )
            let (runExit, stdout) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated program must run successfully. Output:\n" + stdout)
            return stdout
        }

        private func WriteFile(workDir string, fileName string, contents string) string {
            let path = Path.Combine(workDir, fileName)
            File.WriteAllText(path, contents)
            return path
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
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

        // Collapses incidental whitespace/newlines so assertions on call-site
        // shape are not sensitive to the printer's exact line-wrapping.
        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}
