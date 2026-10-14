// <copyright file="Issue3837EntryTypeExportedSurfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Regression coverage for issue #3837: T3 (ADR-0115 §B.1/§B.11) flattens the
/// C# entry class to top-level G#, which erases the class from the migrated
/// assembly. Issue #3645 added a pipeline opt-in that keeps the class for an
/// executable a sibling project declares a literal `ProjectReference` to,
/// but the self-migration corpus reaches `src/Repl` through
/// `<ProjectReference Include="@(GsharpRepl)" />` — an MSBuild item
/// include the declared-reference scan cannot resolve — so the flag never fired
/// and every `GSharp.Repl.Program.*` use site in
/// `test/Interpreter.Tests` failed with GS0157 (plus a GS0154 cascade
/// wherever the use site sat in a lambda whose return type then inferred as
/// `?`).
///
/// The fix makes the decision local and total: an entry class that declares any
/// non-entry member visible outside itself is preserved regardless of what the
/// pipeline can see. A `private`-only entry class exports nothing, so it
/// keeps hoisting to the canonical top-level form.
class Issue3837EntryTypeExportedSurfaceTests {
    /// The end-to-end regression: the migrated entry class survives as a real
    /// CLR type in its own assembly, and a SEPARATE consuming assembly binds it
    /// both fully qualified (`Demo.Cli.DemoProgram.Run`, the
    /// `GSharp.Repl.Program.Main` spelling) and through an import alias
    /// (the `ReplProgram` spelling). Fails on `origin/main`: the class
    /// is flattened away and both spellings raise GS0157.
    @Fact
    func ExportedEntryClass_IsConsumableFromAReferencingAssembly() {
        let printed = TranslateEntrySource(ExportingEntrySource)
        Assert.Contains("class DemoProgram", printed, StringComparison.Ordinal)
        const consumer = `import System
import DemoAlias = Demo.Cli.DemoProgram

Console.WriteLine(Demo.Cli.DemoProgram.Run(2))
Console.WriteLine(DemoAlias.Describe())`
        let (exit, stdout) = CompileLibraryAndRunConsumer(printed, consumer)
        Assert.Equal(0, exit)
        Assert.Equal(
            []string{"run:2", "2", "demo"},
            stdout
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
        )
    }

    /// The preserved form is still a runnable program: gsc accepts a
    /// class-scoped static `Main` as the entry point (issue #1996), so
    /// preserving the class does not cost the executable its entry point.
    ///
    /// This one also PASSES on `origin/main` — there it exercises the
    /// flattened form instead — so it is a guard rail on the new shape rather
    /// than a proof of the defect.
    @Fact
    func PreservedEntryClass_StillRunsAsTheProgramEntryPoint() {
        let printed = TranslateEntrySource(ExportingEntrySource)
        let (exit, stdout) = CompileAndRunExecutable(printed)
        Assert.Equal(0, exit)
        Assert.Contains("run:0", stdout, StringComparison.Ordinal)
    }

    /// An `internal` helper is assembly-visible surface too — it is exactly
    /// what `test/Interpreter.Tests` consumes from `src/Repl` through
    /// `InternalsVisibleTo` — so it also preserves the class. Fails on
    /// `origin/main`.
    @Fact
    func InternalNonEntryMember_PreservesTheEntryClass() {
        let printed = TranslateEntrySource(InternalHelperEntrySource)
        Assert.Contains("class DemoProgram", printed, StringComparison.Ordinal)
        Assert.Contains("IsValidEngineChoice", printed, StringComparison.Ordinal)
    }

    /// Anti-vacuity guard rail: this one PASSES on `origin/main` and must
    /// keep passing. An entry class whose only non-entry member is
    /// `private` exports nothing, so the canonical T3 top-level form is
    /// unchanged — the fix must not preserve every entry class.
    @Fact
    func PrivateOnlyEntryClass_StillFlattensToTopLevel() {
        let printed = TranslateEntrySource(PrivateOnlyEntrySource)
        Assert.DoesNotContain("class DemoProgram", printed, StringComparison.Ordinal)
        Assert.Contains("func Report", printed, StringComparison.Ordinal)
        let (exit, stdout) = CompileAndRunExecutable(printed)
        Assert.Equal(0, exit)
        Assert.Contains("run:0", stdout, StringComparison.Ordinal)
    }

    shared {
        /// The `src/Repl` shape: a static entry class with consumable helpers.
        private const ExportingEntrySource string = `using System;

namespace Demo.Cli;

public static class DemoProgram
{
    public static int Main(string[] args) => Run(args.Length);

    public static int Run(int count)
    {
        Console.WriteLine("run:" + count);
        return count;
    }

    public static string Describe() => "demo";
}`

        /// The `internal`-helper shape: visible to an InternalsVisibleTo test project.
        private const InternalHelperEntrySource string = `using System;

namespace Demo.Cli;

public static class DemoProgram
{
    public static int Main(string[] args) => 0;

    internal static bool IsValidEngineChoice(string? choice) => choice is null or "emit";
}`

        /// The unchanged shape: nothing but the entry point is visible.
        private const PrivateOnlyEntrySource string = `using System;

namespace Demo.Cli;

public static class DemoProgram
{
    public static int Main(string[] args)
    {
        Report(args.Length);
        return 0;
    }

    private static void Report(int count) => Console.WriteLine("run:" + count);
}`

        private func TranslateEntrySource(source string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("DemoProgram.cs", source)},
                outputKind: OutputKind.ConsoleApplication
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Entry source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            // No `preserveEntryType` opt-in: this is the defaulted path the
            // self-migration corpus takes for `src/Repl` (issue #3837).
            let translator = CSharpToGSharpTranslator()
            return GSharpPrinter.Print(translator.TranslateDocument(document, context))
        }

        private func CompileAndRunExecutable(printedProgram string)(Exit int32, Stdout string) {
            let workDir = CreateWorkDirectory()
            let sourcePath = Path.Combine(workDir, "Program.gs")
            File.WriteAllText(sourcePath, printedProgram)
            let exePath = Path.Combine(workDir, "Program.dll")
            CompileOrFail("/target:exe /out:\"$exePath\" \"$sourcePath\"", printedProgram)
            return RunDotnet("\"$exePath\"")
        }

        private func CompileLibraryAndRunConsumer(printedLibrary string, consumerProgram string)(
            Exit int32,
            Stdout string
        ) {
            let workDir = CreateWorkDirectory()
            let libSourcePath = Path.Combine(workDir, "DemoProgram.gs")
            File.WriteAllText(libSourcePath, printedLibrary)
            // gsc names the emitted assembly after the package, so the output file
            // must be `Demo.Cli.dll` for the consumer to resolve it at run time.
            let libPath = Path.Combine(workDir, "Demo.Cli.dll")
            CompileOrFail("/target:library /out:\"$libPath\" \"$libSourcePath\"", printedLibrary)
            let consumerSourcePath = Path.Combine(workDir, "Consumer.gs")
            File.WriteAllText(consumerSourcePath, consumerProgram)
            let consumerPath = Path.Combine(workDir, "Consumer.dll")
            CompileOrFail(
                "/target:exe /reference:\"$libPath\" /out:\"$consumerPath\" \"$consumerSourcePath\"",
                printedLibrary + `
---
` + consumerProgram
            )
            // Both assemblies land in the same directory, so the consumer resolves
            // its dependency at run time without any probing configuration.
            return RunDotnet("\"$consumerPath\"")
        }

        private func CompileOrFail(arguments string, translated string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let (exit, log) = RunDotnet("\"$compiler\" $arguments")
            Assert.True(
                exit == 0 && !log.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated source with zero errors. Output:\n" + log + `

Translated G#:
` + translated
            )
        }

        private func CreateWorkDirectory() string {
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-3837-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            return workDir
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
