// <copyright file="L1MigrationEndToEndTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks
import Xunit

/// The canonicalization milestone for issue #914: the real L1-Console corpus
/// migrates end-to-end — translate (T1 tuples / T2 constructor ABI / T3
/// entry-point → top-level) → canonical G# that round-trips → compiles with the
/// real `gsc` → runs → stdout exactly matches the C# baseline golden.
open class L1MigrationEndToEndTests {
    /// Translating L1 produces canonical G# that round-trips and exhibits the
    /// three transforms: T1 native positional tuples, T2 explicit constructor
    /// and private field preservation, and T3 top-level funcs and statements
    /// (no `shared { }` wrapper, no leftover `Main` method). No
    /// (cref:TranslationSeverity.Unsupported) diagnostic survives.
    @Fact
    async func L1Corpus_CanonicalizesWithAllThreeTransforms() {
        let (unit, context, printed) = await TranslateL1Async()
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(
            roundTrip!!.Success,
            "Canonical L1 must round-trip-parse. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
        )
        // T1 (ADR-0172): the named C# tuple type keeps its element names
        // name-first, and named element access stays by-name.
        Assert.Contains("List[(Name string, Price int32, Quantity int32)]", printed)
        Assert.Contains("item.Price * item.Quantity", printed)
        // T2: the explicit constructor keeps its source parameter name and both
        // readonly fields remain private instead of becoming primary fields.
        Assert.Contains("class Cart {", printed)
        Assert.Contains("private let _customer string", printed)
        Assert.Contains("private let _items List[(Name string, Price int32, Quantity int32)]", printed)
        Assert.Contains("init(customer string)", printed)
        // The C# ctor spells the unnamed shape (`new List<(string, int, int)>()`)
        // — the translation is faithful to each spelling.
        Assert.Contains("_items = List[(string, int32, int32)]()", printed)
        // T3: the entry class became top-level — a top-level func and the entry
        // body as top-level statements — with no `shared { }` block and no `Main`.
        Assert.Contains("private func PrintFizzBuzz(upTo int32) {", printed)
        Assert.Contains("${Environment.NewLine}let cart = Cart(\"Ada\")", printed)
        Assert.DoesNotContain("shared {", printed)
        Assert.DoesNotContain("func Main", printed)
        // No construct is left as an Unsupported placeholder.
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.DoesNotContain("// unsupported", printed)
    }

    /// The full migration proof: the translated L1 compiles with the real
    /// `gsc` (zero errors) and the produced program's stdout exactly matches
    /// `baseline.stdout.golden`. The compile/run steps are gated on the
    /// compiler artifact being present (it is when the solution is built, e.g. the
    /// `GSharp.sln` gate or `scripts/migrate-l1.sh`); when only the cs2gs
    /// test project is built the assertions above still run.
    @Fact
    async func L1Corpus_CompilesWithGscAndMatchesBaseline() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            // gsc.dll is not built in this run; the translate + round-trip proof in
            // L1Corpus_CanonicalizesWithAllThreeTransforms still applies and
            // scripts/migrate-l1.sh exercises the full gsc path.
            return
        }
        let (_, _, printed) = await TranslateL1Async()
        let workDir = Path.Combine(AppContext.BaseDirectory, "l1-e2e")
        Directory.CreateDirectory(workDir)
        let gsPath = Path.Combine(workDir, "L1.gs")
        let dllPath = Path.Combine(workDir, "L1.dll")
        File.WriteAllText(gsPath, printed)
        let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated L1 with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
        )
        let (runExit, stdout) = RunDotnet("\"$dllPath\"")
        Assert.True(runExit == 0, "Translated L1 must run successfully. Output:\n" + stdout)
        let baselinePath string? = ResolveCorpusFile("L1-Console", "baseline.stdout.golden")
        let parity = StdoutParity.CompareFile(baselinePath, stdout)
        Assert.True(parity.IsMatch, parity.Describe())
    }

    shared {
        private async func TranslateL1Async()(Unit CompilationUnit, Context TranslationContext, Printed string) {
            let projectPath string? = ResolveCorpusFile("L1-Console", "L1-Console.csproj")
            let project = await CSharpProjectLoader.LoadProjectAsync(projectPath)
            Assert.True(
                project.BoundWithoutErrors,
                "L1-Console should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = project.Documents.Single(
                (d LoadedDocument) -> d.FilePath.EndsWith("Program.cs", StringComparison.Ordinal)
            )
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context, GSharpPrinter.Print(unit))
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

        private func ResolveCorpusFile(projectFolder string, fileName string) string? -> TestFixtureSource.Resolve(
            "tools",
            "cs2gs",
            "corpus",
            projectFolder,
            fileName
        )
    }
}
