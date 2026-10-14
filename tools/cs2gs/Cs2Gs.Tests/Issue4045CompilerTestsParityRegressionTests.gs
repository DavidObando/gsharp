// <copyright file="Issue4045CompilerTestsParityRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4045: migrated Compiler.Tests must preserve explicitly declared CLR
/// delegate identity and must not turn intentionally nullable reflection
/// results into checked G# assertions.
class Issue4045CompilerTestsParityRegressionTests {
    @Fact
    func ExplicitDelegateAndIntentionalNullResults_PreserveSourceSemantics() {
        let printed = Translate(Source)
        Assert.Contains(
            "let handler EventHandler = (_ object?, _ EventArgs) -> hits++",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("method.Invoke(bell, nil)!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let ex = Capture(() -> method.Invoke(bell, nil))!!", printed, StringComparison.Ordinal)
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let workDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4045CompilerTestsParityRegressionTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(workDir)
        let gsPath = Path.Combine(workDir, "Program.gs")
        let dllPath = Path.Combine(workDir, "Program.dll")
        File.WriteAllText(gsPath, printed)
        let (compileExit, compileOutput) = RunDotnet(
            "\"$compiler\" /target:exe /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
        )
        Assert.True(compileExit == 0, "gsc must compile the translated program. Output:\n" + compileOutput + `

Translated G#:
` + printed)
        if IlVerifyRunner.IsEnabled {
            let verifier = IlVerifyRunner()
            Assert.True(verifier.EnsureToolAvailable(), "dotnet-ilverify must be available.")
            let verify = verifier.Verify(dllPath)
            Assert.True(
                verify.Errors.Count == 0,
                "ilverify reported findings:\n" + string.Join(
                    Environment.NewLine,
                    verify.Errors.Select((error IlVerifyError) -> error.RawLine)
                )
            )
        }
        File.WriteAllText(Path.Combine(workDir, "Program.runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
` + "    \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \"" + Environment.Version.Major.ToString() + `.0.0" }
  }
}
`)
        let (runExit, output) = RunDotnet("\"$dllPath\"")
        Assert.Equal(0, runExit)
        Assert.Equal("2|True", output.Trim())
    }

    @Fact
    func RecordExceptionAroundNullableReflectionResult_DoesNotAddRuntimeAssertions() {
        let printed = Translate(XunitReflectionSource)
        let lines = printed
            .Split('\n')
            .Where((candidate string) -> candidate.Contains("Record.Exception", StringComparison.Ordinal))
            .ToArray()
        Assert.Equal(2, lines.Length)
        Assert.Contains(
            lines,
            (line string) -> line.Contains("let ex = Record.Exception", StringComparison.Ordinal) && line.Contains(
                "actual = Invoke(",
                StringComparison.Ordinal
            )
        )
        Assert.All(
            lines,
            (line string) -> {
                Assert.DoesNotContain(")!!", line, StringComparison.Ordinal)
            }
        )
    }

    shared {
        private const XunitReflectionSource string = `#nullable disable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Xunit;

public static class ReflectionProbe
{
    private static object Invoke(Assembly assembly, string typeName, string methodName = "Run") =>
        assembly.GetType(typeName, throwOnError: true).GetMethod(methodName).Invoke(null, null);

    private static void InScope(Action action) => action();

    public static void Run(IEnumerable<Assembly> assemblies)
    {
        InScope(() =>
        {
            object actual = string.Empty;
            var ex = Record.Exception(() => actual = Invoke(assemblies.Last(), "Probe.Api"));
            Assert.Null(ex);
        });
        Assert.Null(Record.Exception(() => assemblies.Last().GetType("Probe.Api")));
    }
}`

        private const Source string = `#nullable enable
using System;
using System.Reflection;

public sealed class Bell
{
    public event EventHandler? Rang;

    public void Ring() => Rang?.Invoke(this, EventArgs.Empty);
}

public static class Probe
{
    private static Exception? Capture(Func<object?> action)
    {
        try
        {
            action();
            return null;
        }
        catch (Exception ex)
        {
            return ex;
        }
    }

    public static void Main()
    {
        var bell = new Bell();
        var hits = 0;
        EventHandler handler = (_, _) => hits++;
        typeof(Bell).GetEvent("Rang")!.AddEventHandler(bell, handler);
        bell.Ring();

        MethodInfo method = typeof(Bell).GetMethod("Ring")!;
        var ex = Capture(() => method.Invoke(bell, null));
        Console.WriteLine(hits.ToString() + "|" + (ex is null).ToString());
    }
}`

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Issue4045.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(startInfo)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll")
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
