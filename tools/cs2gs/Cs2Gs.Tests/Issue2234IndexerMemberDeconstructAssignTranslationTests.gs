// <copyright file="Issue2234IndexerMemberDeconstructAssignTranslationTests.cs" company="GSharp">
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
import System.Text
import Xunit

/// Issue #2234: a deconstruction-ASSIGNMENT whose targets are indexer
/// (`arr[i]`) or member-access (`obj.F`) expressions — e.g. the
/// classic tuple-swap-via-indexers `(entries[idx], entries[target]) =
/// (entries[target], entries[idx]);` — was gapped loudly (CS2GS-GAP) by
/// issue #1895's lowering: that lowering spills the whole right-hand side
/// FIRST into a native `let (t0, t1, ...) = rhs` binding and only then
/// writes each target, which reverses C#'s left-to-right, targets-then-value
/// evaluation order for any target with a pre-existing storage location to
/// evaluate (an indexer's receiver/index, a member access's receiver).
///
/// Issue #3353 moved that ordering guarantee into G#'s native multi-target
/// assignment. cs2gs can now emit storage targets directly without D2 spills
/// or `__deconN` temps; runtime tests below pin same C# order.
open class Issue2234IndexerMemberDeconstructAssignTranslationTests {
    @Fact
    func ElementAccessTargets_MixedWithIdentifier_LowersWithoutGap() {
        let rendered = Render(`
namespace Corpus.Issue2234
{
    public class Holder
    {
        public void M()
        {
            int[] arr = new int[3];
            int i = 0;
            int j = 1;
            int y = 5;
            (arr[i], arr[j], y) = (10, 20, 30);
            System.Console.WriteLine(arr[0] + arr[1] + y);
        }
    }
}
`)
        AssertRoundTripParses(rendered)
        Assert.Contains("arr[i]", rendered)
        Assert.Contains("arr[j]", rendered)
    }

    @Fact
    func MemberAndElementAccessTargets_Mixed_LowersWithoutGap() {
        let rendered = Render(`
namespace Corpus.Issue2234
{
    public class Box
    {
        public int F;
    }

    public class Holder
    {
        public void M()
        {
            var obj = new Box();
            int[] arr = new int[2];
            int i = 0;
            int a = 1;
            int b = 2;
            (obj.F, arr[i], a) = (b, obj.F, 7);
            System.Console.WriteLine(obj.F + arr[0] + a);
        }
    }
}
`)
        AssertRoundTripParses(rendered)
        Assert.Contains("obj.F", rendered)
        Assert.Contains("arr[i]", rendered)
    }

    @Fact
    func NestedTupleTarget_WithElementAccessLeaf_LowersWithoutGap() {
        let rendered = Render(`
namespace Corpus.Issue2234
{
    public class Holder
    {
        public void M()
        {
            int[] arr = new int[2];
            int i = 0;
            int c = 0;
            ((arr[i], c), c) = ((1, 2), 3);
            System.Console.WriteLine(arr[0] + c);
        }
    }
}
`)
        AssertRoundTripParses(rendered)
        Assert.Contains("arr[i]", rendered)
    }

    /// The issue's exact repro: a tuple-swap performed entirely through
    /// indexer targets. Proves — by actually running the translated G#
    /// through the real `gsc` compiler — that the swap produces the
    /// CORRECT swapped values, not just that it compiles.
    @Fact
    func SwapViaIndexers_CompilesAndRunsWithCorrectResult() {
        let printed = TranslateUnit(`
using System.Collections.Generic;
namespace Corpus.Issue2234
{
    public class Holder
    {
        public void Swap(List<int> entries, int idx, int target)
        {
            (entries[idx], entries[target]) = (entries[target], entries[idx]);
        }
    }
}`)
        Assert.DoesNotContain("(entries[idx], entries[target]) =", printed)
        Assert.Contains("entries[idx], entries[target] = entries[target], entries[idx]", printed)
        Assert.DoesNotContain("__decon", printed)
        Assert.DoesNotContain("__spill", printed)
        let output = CompileAndRunCapturingOutput(
            printed,
            "var e = List[int32]{ 1, 2, 3, 4, 5 }\n" +
                "Holder().Swap(e, 1, 3)\n" +
                "Console.WriteLine(e[0])\n" +
                "Console.WriteLine(e[1])\n" +
                "Console.WriteLine(e[3])\n" +
                "Console.WriteLine(e[4])"
        )
        Assert.Equal(
            "1" + Environment.NewLine + "4" + Environment.NewLine + "2" + Environment.NewLine + "5",
            output.Trim()
        )
    }

    /// Proves left-to-right evaluation order is preserved for a target whose
    /// index expression has an observable side effect: C# evaluates every
    /// target's storage location (left to right) BEFORE the right-hand side
    /// (also left to right), then performs the assignments. An ordered log
    /// records the actual order the translated-and-compiled G# runs in.
    @Fact
    func ElementAccessTargets_SideEffectingIndices_PreserveLeftToRightEvaluationOrder() {
        let printed = TranslateUnit(`
using System.Collections.Generic;
namespace Corpus.Issue2234
{
    public class Holder
    {
        public static List<string> Log = new List<string>();

        public static int Idx(string tag, int i)
        {
            Log.Add(tag);
            return i;
        }

        public static int Val(string tag, int v)
        {
            Log.Add(tag);
            return v;
        }

        public void Run(int[] arr)
        {
            (arr[Idx("L0", 0)], arr[Idx("L1", 1)]) = (Val("R0", 10), Val("R1", 20));
        }
    }
}`)
        let output = CompileAndRunCapturingOutput(
            printed,
            "var arr = []int32{0, 0}\n" +
                "Holder().Run(arr)\n" +
                "Console.WriteLine(arr[0])\n" +
                "Console.WriteLine(arr[1])\n" +
                "Console.WriteLine(String.Join(\",\", Holder.Log))"
        )
        let lines = output.Trim().Split(Environment.NewLine)
        Assert.Equal("10", lines[0])
        Assert.Equal("20", lines[1])
        Assert.Equal("L0,L1,R0,R1", lines[2])
        Assert.DoesNotContain("__decon", printed)
        Assert.DoesNotContain("__spill", printed)
    }

    shared {
        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }

        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            let printed = GSharpPrinter.Print(unit)
            AssertRoundTripParses(printed)
            return printed
        }

        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        /// Compiles [`printed`](paramref) (with [`topLevelCode`](paramref)
        /// appended as top-level entry statements) with the real `gsc` and
        /// runs it, returning captured stdout — proving the translated snippet
        /// not only compiles but produces the correct runtime values.
        private func CompileAndRunCapturingOutput(printed string, topLevelCode string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2234-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + topLevelCode + Environment.NewLine)
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, runOut) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut)
            return runOut
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
            let sibling = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
            if File.Exists(sibling) {
                return sibling
            }
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
