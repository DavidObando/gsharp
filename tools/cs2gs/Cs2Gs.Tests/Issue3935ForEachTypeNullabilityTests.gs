// <copyright file="Issue3935ForEachTypeNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3935: #3925 started emitting the DECLARED `foreach` type as a
/// typed range clause for every non-`var` loop. That type is mapped
/// straight from the loop's type SYNTAX, so it bypasses the oblivious
/// null-taint promotion every other declaration sink goes through — a tuple
/// element the analysis rendered `([]uint8)?` at the parameter came back
/// as a bare `[]uint8` on the loop variable alone, and the live
/// `temporary.Original == nil` guard folded into GS0523 ("comparison of
/// non-nullable with nil is always false"). This is the shape in
/// `Cs2Gs.Pipeline`'s `SdkCompileRunner.RestoreTemporaryBuildProps`
/// that took `Cs2Gs.Pipeline` and `Cs2Gs.Report` red.
///
/// When the element conversion is an IDENTITY conversion the annotation carries
/// no information — the loop variable's type IS the sequence's element type —
/// so it is omitted and G# infers the promoted element type. A genuine element
/// conversion still emits its typed range clause (that is what #3925 replaced
/// `__foreachN` synthesis with), now routed through the same declaration
/// promotion as any other local.
class Issue3935ForEachTypeNullabilityTests {
    /// The regression test. On `origin/main` the loop variable is re-spelled
    /// `(Path string, Original []uint8)` and gsc reports GS0523 on the guard.
    @Fact
    func IdentityConvertedForEachOverPromotedTupleElement_KeepsGuardLiveAndExecutes() {
        let printed = Translate(TaintedTupleElementProgram, OutputKind.ConsoleApplication)
        // The taint analysis promotes the consumer's parameter element...
        Assert.Contains("Original []?uint8", printed, StringComparison.Ordinal)
        // ...and the loop variable must not re-spell it as a bare `[]uint8`.
        Assert.DoesNotContain("for temporary (Path string, Original []uint8) in", printed, StringComparison.Ordinal)
        Assert.Contains("for temporary in temporaryBuildProps", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__foreach", printed, StringComparison.Ordinal)
        // The `== null` guard is live in C#, so it must survive translation.
        Assert.Contains("temporary.Original == nil", printed, StringComparison.Ordinal)
        let (dllPath, stdout, exit) = CompileVerifyAndRun(
            printed,
            "IdentityConvertedForEachOverPromotedTupleElement_KeepsGuardLiveAndExecutes"
        )
        Assert.Equal(0, exit)
        // Both branches of the guard actually run — binding alone would not
        // prove the dead-comparison fold was avoided rather than hidden.
        Assert.Equal(
            []string{"delete ab", "restore abcde 5"},
            stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select((l string) -> l.Trim()).ToArray()
        )
        AssertIlVerifies(dllPath)
    }

    /// An identity-converted loop over a plain (untainted) element type also
    /// drops the redundant annotation, and the loop still binds and runs.
    @Fact
    func IdentityConvertedForEachOverPlainElement_DropsRedundantType() {
        const source = `using System;
using System.Collections.Generic;

namespace Repro;

public static class Sum
{
    public static int Total(IEnumerable<int> values)
    {
        int total = 0;
        foreach (int value in values)
        {
            total += value;
        }

        return total;
    }

    public static void Main()
    {
        Console.WriteLine(Total(new List<int> { 1, 2, 3 }));
    }
}`
        let printed = Translate(source, OutputKind.ConsoleApplication)
        Assert.Contains("for value in values", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("for value int in", printed, StringComparison.Ordinal)
        let (dllPath, stdout, exit) = CompileVerifyAndRun(
            printed,
            "IdentityConvertedForEachOverPlainElement_DropsRedundantType"
        )
        Assert.Equal(0, exit)
        Assert.Equal("6", stdout.Trim())
        AssertIlVerifies(dllPath)
    }

    /// The anti-vacuity guard rail: a NON-identity element conversion still
    /// emits its typed range clause, so #3925's win is intact. This assertion
    /// (and (cref:Issue2638TypedForEachTranslationTests)) passes on
    /// `origin/main` too.
    @Fact
    func NonIdentityElementConversion_StillEmitsTypedRangeClause() {
        const source = `using System;
using System.Collections;

namespace Repro;

public static class Widen
{
    public static int Count(ArrayList items)
    {
        int count = 0;
        foreach (string item in items)
        {
            count += item.Length;
        }

        return count;
    }

    public static void Main()
    {
        Console.WriteLine(Count(new ArrayList { "ab", "cde" }));
    }
}`
        let printed = Translate(source, OutputKind.ConsoleApplication)
        Assert.Contains("for item string in items", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__foreach", printed, StringComparison.Ordinal)
        let (dllPath, stdout, exit) = CompileVerifyAndRun(
            printed,
            "NonIdentityElementConversion_StillEmitsTypedRangeClause"
        )
        Assert.Equal(0, exit)
        Assert.Equal("5", stdout.Trim())
        AssertIlVerifies(dllPath)
    }

    shared {
        /// A faithful reduction of `SdkCompileRunner`: a nullable-oblivious
        /// tuple element that genuinely holds `null`, flowed through
        /// a call so the taint analysis promotes the consumer's parameter, and read
        /// back behind a live `== null` guard inside an explicitly typed
        /// `foreach`. `Main` exercises BOTH guard branches.
        private const TaintedTupleElementProgram string = `using System;
using System.Collections.Generic;

namespace Repro;

public static class Props
{
    public static IReadOnlyList<(string Path, byte[] Original)> Prepare(IEnumerable<string> paths)
    {
        var prepared = new List<(string Path, byte[] Original)>();
        foreach (string path in paths)
        {
            byte[] original = path.Length > 3 ? new byte[path.Length] : null;
            prepared.Add((path, original));
        }

        return prepared;
    }

    public static void Restore(IEnumerable<(string Path, byte[] Original)> temporaryBuildProps)
    {
        foreach ((string Path, byte[] Original) temporary in temporaryBuildProps)
        {
            if (temporary.Original == null)
            {
                Console.WriteLine("delete " + temporary.Path);
            }
            else
            {
                Console.WriteLine("restore " + temporary.Path + " " + temporary.Original.Length);
            }
        }
    }

    public static void Main()
    {
        Restore(Prepare(new List<string> { "ab", "abcde" }));
    }
}`

        // ---- harness -----------------------------------------------------------
        private func Translate(source string, outputKind OutputKind) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Repro.cs", source)},
                references: nil,
                outputKind: outputKind
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        private func CompileVerifyAndRun(printed string, caseName string)(DllPath string, Stdout string, Exit int32) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "Issue3935ForEachTypeNullabilityTests", caseName)
            if Directory.Exists(workDir) {
                Directory.Delete(workDir, recursive: true)
            }
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Program.gs")
            File.WriteAllText(gsPath, printed)
            let dllPath = Path.Combine(workDir, "Program.dll")
            let (compileExit, compileOut) = RunDotnet(
                "\"$compiler\" /target:exe /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
            )
            Assert.True(compileExit == 0, "gsc must compile the translated program. Output:\n" + compileOut + `

Translated G#:
` + printed)
            Assert.DoesNotContain("GS0523", compileOut, StringComparison.Ordinal)
            File.WriteAllText(Path.Combine(workDir, "Program.runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
` + "    \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \"" + Environment.Version.Major.ToString() + `.0.0" }
  }
}
`)
            let (exit, output) = RunDotnet("\"$dllPath\"")
            return (dllPath, output, exit)
        }

        private func AssertIlVerifies(dllPath string) {
            let result = IlVerifyRunner().Verify(dllPath)
            Assert.True(
                result.Errors.Count == 0,
                "ilverify reported findings:\n" + string.Join(
                    Environment.NewLine,
                    result.Errors.Select((e IlVerifyError) -> e.RawLine)
                )
            )
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
