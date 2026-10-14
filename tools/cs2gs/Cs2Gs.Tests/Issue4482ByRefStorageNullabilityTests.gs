// <copyright file="Issue4482ByRefStorageNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Issue #4482: cs2gs widens an oblivious `out`/`ref` parameter that
/// is assigned `null` to `T?`. Since #4461, gsc requires the storage
/// passed to a by-ref parameter to match its nullability exactly (GS0612), so the
/// caller's storage must widen with it. Two shapes did not: an array ELEMENT
/// passed by `out` (`out failures[i]`, from
/// `CSharpToGSharpTranslator.Patterns`, which broke the hot-core guard),
/// and a local passed by `ref`. Declared, inline and inferred `out`
/// locals and a field already widened.
open class Issue4482ByRefStorageNullabilityTests {
    /// Every by-ref storage shape widens with its parameter: the translation
    /// compiles with no GS0612 and runs with C#'s result, the nils included.
    @Fact
    func ByRefStorage_WidensWithTheParameter_CompilesCleanAndRuns() {
        let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Snippet.cs", Source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("let failures = [2]string?", printed)
        Assert.Contains("var r string? = \"x\"", printed)
        let (compileOutput, runOutput) = CompileAndRun(printed, "Holder.Run()")
        Assert.DoesNotContain("GS0612", compileOutput)
        Assert.Equal("3-positive-positivepositive-", runOutput.Trim())
    }

    shared {
        private const Source string = `
public class Holder
{
    public string Field;

    private static int Find(int x, out string failureReason)
    {
        failureReason = null;
        if (x > 0) { failureReason = "positive"; return 1; }
        return 0;
    }

    private static void Swap(ref string s) { s = null; }

    public static string Run()
    {
        var failures = new string[2];
        int a = Find(0, out failures[0]);
        int b = Find(2, out string inline);
        int c = Find(0, out var inferred);
        string declared;
        int d = Find(3, out declared);
        var h = new Holder();
        int e = Find(4, out h.Field);
        string r = "x";
        Swap(ref r);
        return a + b + c + d + e + (failures[0] ?? "-") + (inline ?? "-") + (inferred ?? "-") + (declared ?? "-") + (h.Field ?? "-") + (r ?? "-");
    }
}`

        private func CompileAndRun(printed string, callExpression string)(CompileOutput string, RunOutput string) {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-4482-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(
                    gsPath,
                    printed + Environment.NewLine + "Console.WriteLine($callExpression)" + Environment.NewLine
                )
                let (compileExit, compileOutput) = RunDotnet(compiler, "/target:exe", "/out:$dllPath", gsPath)
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet. Output:\n" + compileOutput + `

Translated G#:
` + printed
                )
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "Translated snippet must run. Output:\n" + runOutput)
                return (compileOutput, runOutput)
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
