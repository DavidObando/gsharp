// <copyright file="Issue5562DefaultConstructorByRefTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #5562: C# `new Mixed()` on a class with no explicit constructor, no instance field initializer, and no
/// static constructor translates to `Mixed()` without a `!!` assertion on a guarded `out` or `ref` parameter, and
/// `gsc` compiles and runs the translated program because `ConstructionRunsUserCode` is false.
open class Issue5562DefaultConstructorByRefTests {
    @Fact
    func OutParameter_ReadAfterClassDefaultConstructorCall_StaysBareAndCompilesAndRuns() {
        let printed = Translate(`
public sealed class Mixed
{
    public int Id;
}
public class Demo
{
    static string? Pick() => "hello";
    public static int Run(out string? text)
    {
        text = Pick();
        if (text is null)
        {
            return 0;
        }
        var made = new Mixed();
        return made.Id + text.Length;
    }
    public static void Main()
    {
        System.Console.WriteLine(Run(out _));
    }
}`, OutputKind.ConsoleApplication)
        Assert.DoesNotContain("text!!", printed)
        let output = CompileAndRunWithGsc(printed)
        Assert.Equal("5", output.Trim())
    }

    @Fact
    func RefParameter_ReadAfterClassDefaultConstructorCallWithStaticLiteralField_StaysBareAndCompiles() {
        let printed = Translate(`
public sealed class Mixed
{
    public int Id;
    public static readonly int Seed = 4;
}
public class Demo
{
    public static int Run(ref string? text)
    {
        if (text is null)
        {
            return 0;
        }
        var made = new Mixed();
        return made.Id + text.Length;
    }
}`)
        Assert.DoesNotContain("text!!", printed)
        AssertCompilesWithGsc(printed)
    }

    shared {
        private func AssertCompilesWithGsc(printed string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "Issue5562DefaultConstructorByRefTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Probe.gs")
                let dllPath = Path.Combine(workDir, "Probe.dll")
                File.WriteAllText(gsPath, printed)
                let (exitCode, output) = RunDotnet(
                    "\"$compiler\" /target:library /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
                )
                Assert.True(exitCode == 0, "gsc must compile the translated snippet. Output:\n" + output + `

Translated G#:
` + printed)
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func CompileAndRunWithGsc(printed string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "Issue5562DefaultConstructorByRefTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Probe.gs")
                let exePath = Path.Combine(workDir, "Probe.dll")
                File.WriteAllText(gsPath, printed)
                let (compileExit, compileOutput) = RunDotnet(
                    "\"$compiler\" /target:exe /targetframework:net10.0 /out:\"$exePath\" \"$gsPath\""
                )
                Assert.True(compileExit == 0, "gsc must compile the translated snippet. Output:\n" + compileOutput + `

Translated G#:
` + printed)
                let (runExit, runOutput) = RunDotnet("\"$exePath\"")
                Assert.True(runExit == 0, "Compiled program must run cleanly. Output:\n" + runOutput)
                return runOutput
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("failed to start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
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

        private func Translate(source string, outputKind OutputKind = OutputKind.DynamicallyLinkedLibrary) string {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(outputKind).WithNullableContextOptions(NullableContextOptions.Enable)
            )
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }
    }
}
