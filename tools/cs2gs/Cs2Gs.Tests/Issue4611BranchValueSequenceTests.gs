// <copyright file="Issue4611BranchValueSequenceTests.cs" company="GSharp">
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
import System.Text
import System.Threading.Tasks
import Xunit

/// Issue #4611: #4550's `CreateControlFlowGraph` appended the possibly-null
/// `BasicBlock.BranchValue` to a block's operations and filtered the null
/// afterwards. cs2gs bridges a maybe-null value entering generic storage with a
/// fail-fast `!!` (the settled policy pinned by
/// `ManagedReferenceArrayNilCannotSilentlyEnterFixedGenericStorage`), so the
/// migrated translator threw on the first block without a branch value. The
/// translator source now yields the branch value only when present.
open class Issue4611BranchValueSequenceTests {
    /// Pins today's behavior, deliberately: an oblivious maybe-null value
    /// appended to a sequence keeps its fail-fast `!!`, so C# that stores
    /// a null and filters it later throws once migrated. Whether cs2gs should
    /// instead diagnose that bridge is the open policy follow-up to #4611; until
    /// it is decided, translator source must not store nulls in sequences.
    @Fact
    func MaybeNullAppendedToSequence_KeepsFailFastBridge() {
        let printed = TranslateUnit(`using System.Linq;

public static class C
{
    public static int Appended(string[] items) =>
        items.Append(Branch("x")).Where(s => s != null).Count();
` + MaybeNullHelper + "\n}")
        Assert.Contains(".Append(Branch(\"x\")!!)", printed, StringComparison.Ordinal)
    }

    /// The shape the translator now uses: a branch value that is absent is
    /// never yielded, so the migrated iterator carries no assertion that can
    /// throw, and a block without one contributes only its operations.
    @Fact
    func BranchValueYieldedOnlyWhenPresent_CompileAndRun() {
        let printed = TranslateUnit(`using System.Collections.Generic;
using System.Linq;

public static class Probe
{
    public static string Run() =>
        new[] { "a", "bc" }.SelectMany(OperationsAndBranch).Count().ToString();

    private static IEnumerable<string> OperationsAndBranch(string block)
    {
        foreach (string operation in new[] { block })
        {
            yield return operation;
        }

        if (Branch(block) is { } branchValue)
        {
            yield return branchValue;
        }
    }
` + MaybeNullHelper + "\n}")
        Assert.DoesNotContain("Branch(block)!!", printed, StringComparison.Ordinal)
        // "a" has no branch value and contributes [a]; "bc" contributes [bc, bc].
        Assert.Equal("3", CompileAndRun(printed, "Probe.Run()").Trim())
    }

    /// The discriminating witness (ADR-0154): translate the translator's own
    /// `CSharpToGSharpTranslator.Statements.cs`, exactly as the
    /// self-migration does, and reject any fail-fast bridge on a block's branch
    /// value. The #4550 shape migrated to `.Append(block.BranchValue!!)`,
    /// which threw on the first block without a branch value.
    @Fact
    async func TranslatorSelfMigration_NeverAssertsABlockBranchValue() {
        // G# translated from the C# until the cut-over, the committed .gs after (#4661).
        let files = await SelfMigratedCompilerSource.LoadAsync(
            "tools/cs2gs/Cs2Gs.Translator",
            preservePartialParts: true,
            "CSharpToGSharpTranslator.Statements"
        )
        let printed = SelfMigratedCompilerSource.Compact(files["CSharpToGSharpTranslator.Statements"].Text)
        Assert.Contains("BlockOperationsAndBranchValue", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("BranchValue!!", printed, StringComparison.Ordinal)
    }

    shared {
        private const MaybeNullHelper string = `#nullable enable
    private static string? Branch(string value) => value.Length > 1 ? value : null;
#nullable restore`

        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
            return printed
        }

        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue4611-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                let unitPath = Path.Combine(workDir, "Unit.gs")
                File.WriteAllText(unitPath, printed)
                let entryPath = Path.Combine(workDir, "Main.gs")
                File.WriteAllText(
                    entryPath,
                    "import System${Environment.NewLine}${Environment.NewLine}Console.WriteLine($callExpression)${Environment.NewLine}"
                )
                let (compileExit, compileOutput) = RunDotnet(
                    compiler,
                    "/target:exe",
                    "/out:$dllPath",
                    unitPath,
                    entryPath
                )
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet with zero errors. Output:\n" + compileOutput + `

Translated G#:
` + printed
                )
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOutput + `

Translated G#:
` + printed)
                return runOutput
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func RunDotnet(arguments ...string?)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(startInfo)
            Assert.NotNull(process)
            let stdout = process!!.StandardOutput.ReadToEndAsync()
            let stderr = process!!.StandardError.ReadToEndAsync()
            if !process!!.WaitForExit(TimeSpan.FromMinutes(5)) {
                process!!.Kill(entireProcessTree: true)
                Assert.Fail("dotnet " + string.Join(' ', arguments) + " did not exit within 5 minutes.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
