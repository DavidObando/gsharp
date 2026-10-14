// <copyright file="Issue3865ImportedObliviousArgumentAssertionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3865: cs2gs emitted a `!!` on arguments passed to IMPORTED
/// parameters that carry no nullable metadata at all (oblivious).
///
/// gsc's import rule is the INVERSE of C#'s. `ClrNullability.IsPositionNonNull`
/// reads "non-null iff the byte is `1`", so an oblivious byte (`0`)
/// and absent metadata BOTH map to `T?`. An imported oblivious parameter
/// therefore already accepts a nullable value, and the assertion is not a
/// widening bridge — it is pure runtime overhead that CHANGES BEHAVIOUR:
/// G#'s `x!!` lowers to `dup; brtrue; pop; newobj NullReferenceException;
/// throw`, unlike C#'s erased `x!`. A legal C# call such as
/// `string.Equals(null, "root", StringComparison.OrdinalIgnoreCase)`
/// (which returns `false`) became a crash in the migrated artifact —
/// invisible to translate, compile and ILVerify, observable only by running it.
///
/// The trigger looked context-sensitive on issue #3862 ("the same
/// `BuildTask.cs` translates clean standalone and with `!!`
/// in-corpus") because the in-memory test harness compiles against the running
/// runtime's fully annotated net10.0 reference assemblies, while the real
/// `src/Sdk/Gsharp.NET.Sdk` targets <b>netstandard2.0</b>, whose reference
/// assemblies contain ZERO `NullableAttribute`. Under netstandard2.0 even
/// `string.IsNullOrEmpty`, `string.Equals` and `bool.TryParse`
/// are oblivious, so there was only ever ONE mechanism, not two.
///
/// The tests below model that faithfully: the "imported" library is emitted to
/// a real metadata image (no `DeclaringSyntaxReference`, exactly like a
/// framework or NuGet reference) from a nullable-DISABLED compilation, and the
/// consumer that calls it is nullable-ENABLED, mirroring
/// `<Nullable>enable</Nullable>` on a netstandard2.0 project.
open class Issue3865ImportedObliviousArgumentAssertionTests {
    @Fact
    func ObliviousImportedParameter_NullableArgument_EmitsNoRuntimeAssertion() {
        let printed = TranslateAgainstLibrary(ObliviousLibrarySource, ConsumerSource)
        Assert.Contains("Sink.Accept(this.Maybe)", Compact(printed), StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func AnnotatedNonNullImportedParameter_NullableArgument_StillAssertsAntiVacuityControl() {
        // Anti-vacuity guard rail: this assertion is required, and it passes on
        // `origin/main` too. Were the fix over-broad (dropping `!!` at every
        // imported target rather than only oblivious ones), this would fail.
        let printed = TranslateAgainstLibrary(AnnotatedLibrarySource, ConsumerSource)
        Assert.Contains("Sink.Accept(this.Maybe!!)", Compact(printed), StringComparison.Ordinal)
    }

    @Fact
    func ObliviousImportedField_NullableAssignment_EmitsNoRuntimeAssertion() {
        const Source = `
#nullable enable
using Imported;

namespace Consumer
{
    public class Caller
    {
        public string? Maybe { get; set; }

        public void Store(Holder holder)
        {
            holder.Field = this.Maybe;
        }
    }
}`
        let printed = TranslateAgainstLibrary(ObliviousLibrarySource, Source)
        Assert.Contains("holder.Field = this.Maybe", Compact(printed), StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func ObliviousImportedParameter_SubstitutedGenericTargetStillAsserts() {
        // A generic BCL target such as `List<string>.Add(T item)` declares its
        // parameter as the TYPE PARAMETER `T` (`NullableAnnotation.None`), which
        // says nothing about obliviousness — gsc binds the substituted `string`
        // as non-null. The fix keys off the ORIGINAL definition's type and
        // excludes type parameters, so this still asserts. Passes on
        // `origin/main` as well; it exists to pin the exclusion.
        const Source = `
#nullable enable
using System.Collections.Generic;

namespace Consumer
{
    public class Caller
    {
        public string? Maybe { get; set; }

        public void Fill(List<string> items)
        {
            items.Add(this.Maybe);
        }
    }
}`
        let printed = TranslateAgainstLibrary(ObliviousLibrarySource, Source)
        Assert.Contains("items.Add(this.Maybe!!)", Compact(printed), StringComparison.Ordinal)
    }

    /// The defect class is definitionally invisible to translate, compile and
    /// ILVerify, so the regression has to EXECUTE. Compiles the translated G#
    /// with the real gsc against the real oblivious library image and asserts
    /// the program prints what the equivalent C# prints instead of throwing
    /// (cref:NullReferenceException).
    @Fact
    func ObliviousImportedParameter_NullArgument_RunsWithoutThrowing() {
        const Source = `
#nullable enable
using System;
using Imported;

namespace Consumer
{
    public static class Program
    {
        public static string? Maybe { get; set; }

        public static void Main()
        {
            Console.WriteLine("before");
            Console.WriteLine(Sink.Accept(Maybe));
            Console.WriteLine(Sink.AcceptTwo(Maybe, Maybe));
            Console.WriteLine("after");
        }
    }
}`
        let (printed, libraryImage) = TranslateAgainstLibraryWithImage(
            ObliviousLibrarySource,
            Source,
            OutputKind.ConsoleApplication
        )
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        let (exit, stdout) = CompileAndRun(printed, libraryImage)
        // C# semantics for the identical program: `value == null` is `true`.
        Assert.Equal(0, exit)
        Assert.Equal(
            []string{"before", "True", "True", "after"},
            stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select((l string) -> l.Trim()).ToArray()
        )
    }

    /// The same executing proof for the two OTHER sink shapes whose existing
    /// expectations this fix changes — an imported oblivious PROPERTY in an
    /// object initializer (issue #2521's prebuilt-metadata case) and an imported
    /// oblivious INDEXER key argument (issue #2511's `ImportedLookup`
    /// case). Both used to carry a `!!`; this run is the evidence that
    /// removing it is a gratuitous-assertion removal and not lost checking —
    /// gsc compiles the assertion-free form with zero diagnostics AND the
    /// program produces the value the equivalent C# produces instead of
    /// throwing.
    @Fact
    func ObliviousImportedInitializerAndIndexerSinks_RunWithoutThrowing() {
        const Source = `
#nullable enable
using System;
using Imported;

namespace Consumer
{
    public static class Program
    {
        public static string? Maybe { get; set; }

        public static void Main()
        {
            Console.WriteLine("before");
            Target target = new Target { Value = Maybe };
            Console.WriteLine(target.Value == null);
            Lookup lookup = new Lookup();
            lookup[Maybe] = "v";
            Console.WriteLine(lookup[Maybe]);
            Console.WriteLine("after");
        }
    }
}`
        let (printed, libraryImage) = TranslateAgainstLibraryWithImage(
            ObliviousLibrarySource,
            Source,
            OutputKind.ConsoleApplication
        )
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        let (exit, stdout) = CompileAndRun(printed, libraryImage)
        Assert.Equal(0, exit)
        Assert.Equal(
            []string{"before", "True", "<null-key>", "after"},
            stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select((l string) -> l.Trim()).ToArray()
        )
    }

    shared {
        // A nullable-DISABLED library: `Sink.Accept(string)` and `Sink.Field` carry
        // no nullable metadata, exactly like netstandard2.0's `string.Equals` or
        // `Microsoft.Build.Utilities.TaskLoggingHelper.LogError`.
        private const ObliviousLibrarySource string = `
using System;

namespace Imported
{
    public static class Sink
    {
        public static bool Accept(string value)
        {
            return value == null;
        }

        public static bool AcceptTwo(string first, string second)
        {
            return first == null && second == null;
        }
    }

    public class Holder
    {
        public string Field;
    }

    public class Target
    {
        public string Value { get; set; }
    }

    public sealed class Lookup
    {
        public string this[string key]
        {
            get { return key == null ? "<null-key>" : "hit"; }
            set { }
        }
    }
}`

        // The same library, nullable-ENABLED, declaring the parameter NON-nullable.
        // gsc imports that as a genuine non-null `string`, so a nullable argument
        // still needs the `!!` bridge — the anti-vacuity control for the fix.
        private const AnnotatedLibrarySource string = `
#nullable enable
using System;

namespace Imported
{
    public static class Sink
    {
        public static bool Accept(string value)
        {
            return value.Length == 0;
        }

        public static bool AcceptTwo(string first, string second)
        {
            return first.Length == second.Length;
        }
    }

    public class Holder
    {
        public string Field = string.Empty;
    }

    public class Target
    {
        public string Value { get; set; } = string.Empty;
    }

    public sealed class Lookup
    {
        public string this[string key]
        {
            get { return key.Length == 0 ? "empty" : "hit"; }
            set { }
        }
    }
}`

        private const ConsumerSource string = `
#nullable enable
using Imported;

namespace Consumer
{
    public class Caller
    {
        public string? Maybe { get; set; }

        public bool Call() => Sink.Accept(this.Maybe);
    }
}`

        // ---- harness -----------------------------------------------------------
        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split(default([]char), StringSplitOptions.RemoveEmptyEntries)
        )

        private func TranslateAgainstLibrary(
            librarySource string,
            consumerSource string,
            outputKind OutputKind = OutputKind.DynamicallyLinkedLibrary
        ) string -> TranslateAgainstLibraryWithImage(librarySource, consumerSource, outputKind).Printed

        private func TranslateAgainstLibraryWithImage(
            librarySource string,
            consumerSource string,
            outputKind OutputKind
        )(Printed string, LibraryImage ImmutableArray[uint8]) {
            let image = EmitLibraryImage(librarySource)
            // A METADATA reference (not a compilation reference): the imported
            // symbols have no `DeclaringSyntaxReference` at all, which is what a
            // framework/NuGet reference looks like and what the fix keys off.
            let references = CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]MetadataReference{MetadataReference.CreateFromImage(image)})
                .ToList()
            let tree = CSharpSyntaxTree.ParseText(
                consumerSource,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Consumer.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Consumer",
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(outputKind).WithNullableContextOptions(NullableContextOptions.Enable)
            )
            let errors = compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
            Assert.True(
                errors.Count == 0,
                "Consumer should bind with no C# errors: " + string.Join(Environment.NewLine, errors)
            )
            let document = LoadedDocument("Consumer.cs", tree, compilation.GetSemanticModel(tree))
            let context = TranslationContext(compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (GSharpPrinter.Print(unit), image)
        }

        private func EmitLibraryImage(librarySource string) ImmutableArray[uint8] {
            let tree = CSharpSyntaxTree.ParseText(
                librarySource,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Imported.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Imported",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
            )
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            Assert.True(
                result.Success,
                "Imported library must emit: " + string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return ImmutableArray.Create(stream.ToArray())
        }

        private func CompileAndRun(printed string, libraryImage ImmutableArray[uint8])(Exit int32, Stdout string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-3865-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let libraryPath = Path.Combine(workDir, "Imported.dll")
            File.WriteAllBytes(libraryPath, libraryImage.ToArray())
            let gsPath = Path.Combine(workDir, "Program.gs")
            File.WriteAllText(gsPath, printed)
            let dllPath = Path.Combine(workDir, "Program.dll")
            let (compileExit, compileOut) = RunDotnet(
                "\"$compiler\" /target:exe /reference:\"$libraryPath\" /out:\"$dllPath\" \"$gsPath\""
            )
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated program with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            WriteRuntimeConfig(Path.Combine(workDir, "Program.runtimeconfig.json"))
            return RunDotnet("\"$dllPath\"")
        }

        private func WriteRuntimeConfig(path string) {
            if File.Exists(path) {
                return
            }
            File.WriteAllText(path, `{
  "runtimeOptions": {
    "tfm": "net10.0",
` + "    \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \"" + Environment.Version.Major.ToString() + `.0.0" }
  }
}
`)
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
    }
}
