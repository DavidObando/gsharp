// <copyright file="Issue2211FullyQualifiedNoUsingImportSynthesisTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.ComponentModel
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #2211: back-translating C# that fully-qualifies every type/enum
/// reference with NO `using` directives (the shape a Roslyn source
/// generator emits — see ADR-0145) shortened some of those references to a
/// bare name without synthesizing the matching `import`, producing G#
/// gsc rejects (GS0113/GS0157/GS0202). Root cause: (cref:CSharpTypeMapper)
/// always shortens a non-nested named type to its simple name
/// (`QualifiedTypeName`), relying on the file's own `using`
/// directives to supply a matching `import` — but a generator-shaped
/// file with no `using`s at all has none. This affected EVERY call site
/// funneled through `CSharpTypeMapper.Map` (enum-constant attribute
/// arguments, field/local type annotations, generic type arguments, ...),
/// while a C# attribute's own type name (taken verbatim from syntax, not
/// through the type mapper) stayed fully qualified — the inconsistency the
/// issue observed within one file.
///
/// The fix collects every namespace the type mapper shortens a reference into
/// ((cref:CSharpTypeMapper.ShortenedNamespaces)) and, once the whole
/// file is translated, synthesizes a matching `import` for any such
/// namespace not already covered by the file's own package or an explicit
/// `using` ((cref:CSharpToGSharpTranslator.TranslateDocument)).
open class Issue2211FullyQualifiedNoUsingImportSynthesisTests {
    @Fact
    func EnumArgumentAndFieldType_FullyQualifiedNoUsing_SynthesizesImportAndRoundTrips() {
        // Mirrors the exact shape from the issue: a generator-emitted file with
        // NO `using` directives, an attribute whose enum argument is fully
        // qualified, and a field of a fully-qualified BCL type.
        let printed = TranslateUnit(`
namespace CommunityToolkit.Mvvm.ComponentModel.__Internals
{
    [global::System.ComponentModel.EditorBrowsable(global::System.ComponentModel.EditorBrowsableState.Never)]
    internal static class __KnownINotifyPropertyChangedArgs
    {
        public static readonly global::System.ComponentModel.PropertyChangedEventArgs Message =
            new global::System.ComponentModel.PropertyChangedEventArgs("Message");
    }
}`)
        Assert.Contains("import System.ComponentModel", printed)
        Assert.Contains("EditorBrowsableState.Never", printed)
        Assert.Contains("PropertyChangedEventArgs", printed)
        // Every shortened reference must actually resolve: compile the printed
        // G# with the real gsc. gsc's default (no `/r:`) resolver only probes
        // its own host process's already-loaded assemblies plus a small
        // well-known BCL set (System.Runtime, System.Private.CoreLib, ...) —
        // `PropertyChangedEventArgs` lives in System.ObjectModel.dll, which
        // that process never otherwise loads, so it must be passed explicitly
        // (an infra fact unrelated to this translator fix).
        AssertCompiles(printed, typeof(PropertyChangedEventArgs).Assembly.Location, typeof(object).Assembly.Location)
    }

    @Fact
    func NestedEnumAccessInAttributeArgument_FullyQualifiedNoUsing_SynthesizesImport() {
        // A NESTED BCL enum (`System.Environment.SpecialFolder`) referenced
        // fully-qualified as an attribute argument, with no `using` for its
        // namespace. Exercises the nested-type branch of
        // `CSharpTypeMapper.QualifiedTypeName` (distinct from the top-level
        // `EditorBrowsableState` in the first test).
        let printed = TranslateUnit(`
namespace Demo
{
    public class TagAttribute : global::System.Attribute
    {
        public TagAttribute(global::System.Environment.SpecialFolder folder) { }
    }

    [Tag(global::System.Environment.SpecialFolder.ApplicationData)]
    public class Marker
    {
    }
}`)
        Assert.Contains("SpecialFolder.ApplicationData", printed)
        Assert.Contains(
            printed.Split(Environment.NewLine).Select((l string) -> l.Trim()),
            (l string) -> l == "import System"
        )
        // ponytail: skip a second real-gsc compile here — the first test
        // already proves the mechanism compiles end-to-end; running gsc as a
        // subprocess for every generality case here multiplies process load
        // for no extra coverage (AssertBinds inside TranslateUnit already proves
        // the printed text parses and binds).

    }

    @Fact
    func LocalVariableType_FullyQualifiedNoUsing_SynthesizesImport() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int Length()
        {
            global::System.Text.StringBuilder builder = new global::System.Text.StringBuilder("hi");
            return builder.Length;
        }
    }
}`)
        Assert.Contains("import System.Text", printed)
        Assert.Contains("StringBuilder", printed)
    }

    @Fact
    func GenericTypeArgument_FullyQualifiedNoUsing_SynthesizesImport() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public global::System.Collections.Generic.List<global::System.Text.StringBuilder> Items()
        {
            return new global::System.Collections.Generic.List<global::System.Text.StringBuilder>();
        }
    }
}`)
        Assert.Contains("import System.Collections.Generic", printed)
        Assert.Contains("import System.Text", printed)
    }

    @Fact
    func NestedSourceType_DoesNotQualifyImportedTopLevelGeneric() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Container
    {
        public class List { }
    }

    public class C
    {
        public int Count()
        {
            var values = new System.Collections.Generic.List<int> { 1 };
            values.Add(2);
            return values.Count;
        }
    }
}`)
        Assert.Contains("import System.Collections.Generic", printed)
        Assert.DoesNotContain("import GenericList =", printed)
        Assert.DoesNotContain("__cs2gs_", printed)
        Assert.Contains("let values = List[int32]", printed)
        Assert.DoesNotContain("let values = System.Collections.Generic.List", printed)
    }

    @Fact
    func NamespaceAlreadyCoveredByUsing_NoDuplicateImportSynthesized() {
        // Control: when a `using` already exists for the shortened
        // namespace, no synthesized duplicate is added.
        let printed = TranslateUnit(`
using System.ComponentModel;

namespace Demo
{
    public class C
    {
        public PropertyChangedEventArgs Field = new PropertyChangedEventArgs("X");
    }
}`)
        Assert.Equal(1, CountOccurrences(printed, "import System.ComponentModel"))
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        /// Compiles [`printed`](paramref) with the real `gsc` and asserts
        /// zero errors — proving every shortened reference actually resolves, not
        /// just that the text happens to look right.
        private func AssertCompiles(printed string, extraReferences ...string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2211-e2e", Guid.NewGuid().ToString("N"))
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
            // Read stdout/stderr concurrently to avoid a classic pipe deadlock:
            // reading one stream fully before starting the other can hang forever
            // if the child fills the OS pipe buffer on the stream not yet read.
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
