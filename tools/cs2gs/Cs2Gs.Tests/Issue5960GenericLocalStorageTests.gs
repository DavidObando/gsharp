// <copyright file="Issue5960GenericLocalStorageTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Cli
import Cs2Gs.Pipeline
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import System
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks
import Xunit

open class Issue5960GenericLocalStorageTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    async func ExplicitGenericStorage_PreservesNativeRuntimeBytes(effectful bool) {
        let compiler = LocalFunctionHoistTranslationTests.FindCompiler()
        Assert.NotNull(compiler)
        let repository = GsharpTestProjectRunner.FindRepoRoot()
        Assert.NotNull(repository)
        let directory = Path.Combine(repository!!, ".issue5960-tests-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let sourceRoot = Path.Combine(directory, "source")
            let projectRoot = Path.Combine(sourceRoot, "src", "Probe")
            Directory.CreateDirectory(projectRoot)
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project />")
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.targets"), "<Project />")
            File.WriteAllText(
                Path.Combine(projectRoot, "Probe.csproj"),
                `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><Nullable>enable</Nullable></PropertyGroup></Project>`
            )
            let source = if effectful {
                Source.Replace("T seed = replacement;", "T seed = Read(replacement);").Replace(
                    "seed = clear ? default(T) : flag ? a : b;",
                    "seed = clear ? default(T) : Read(flag ? a : b);"
                )
            } else {
                Source
            }
            File.WriteAllText(Path.Combine(projectRoot, "Probe.cs"), source)
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", source)})
            let native = project.Compilation.WithOptions(
                project.Compilation.Options.WithOutputKind(OutputKind.ConsoleApplication)
            )
            Assert.DoesNotContain(
                native.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            let nativePath = Path.Combine(directory, "Native.dll")
            let emitted = native.Emit(nativePath)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            File.WriteAllText(
                Path.Combine(directory, "Native.runtimeconfig.json"),
                `{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.0"}}}`
            )
            let expected = Run(nativePath)
            Assert.NotEmpty(expected)
            Assert.Contains("False:True:", expected)
            Assert.Contains("False:False:", expected)
            Assert.Contains("True:True:", expected)
            Assert.Contains("zero=0", expected)
            Assert.Contains(
                if effectful {
                    "reads=24"
                } else {
                    "reads=0"
                },
                expected
            )

            let destination = Path.Combine(directory, "translated")
            let originalOut = Console.Out
            let originalError = Console.Error
            let output = StringWriter()
            let errors = StringWriter()
            var exit int32
            try {
                Console.SetOut(output)
                Console.SetError(errors)
                exit = await Program.Main(
                    []string{
                        "migrate",
                        "--corpus",
                        sourceRoot,
                        "--out",
                        destination,
                        "--artifacts",
                        Path.Combine(directory, "runs"),
                        "--gsc",
                        compiler!!,
                        "--diagnostic-run",
                        "--no-via-sdk",
                        "--app",
                        "corpus/Probe",
                        "--stop-after",
                        "translate",
                        "--no-format"
                    }
                )
            } finally {
                Console.SetOut(originalOut)
                Console.SetError(originalError)
            }
            Assert.True(exit == 0, output.ToString() + errors.ToString())
            Assert.DoesNotContain("CS2GS-GENERIC-STORE-BRIDGE", output.ToString() + errors.ToString())
            let translated = Directory.GetFiles(destination, "Probe.gs", SearchOption.AllDirectories)
            let gsPath = Assert.Single(translated)
            let printed = File.ReadAllText(gsPath)
            let translatedPath = Path.Combine(directory, "Translated.dll")
            let compile = ProcessRunner.Run(
                "dotnet",
                []string{compiler!!, "/target:exe", "/targetframework:net10.0", "/out:$translatedPath", gsPath},
                timeout: TimeSpan.FromSeconds(30)
            )
            Assert.False(compile.TimedOut, compile.Output)
            Assert.True(
                compile.ExitCode == 0 && !compile.Output.Contains("warning", StringComparison.OrdinalIgnoreCase),
                compile.Output + "\n" + printed
            )
            Assert.Equal(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(Run(translatedPath)))
            Assert.Contains("var seed T?", printed)
            Assert.DoesNotContain("seed!!", printed)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func Run(path string) string {
            let result = ProcessRunner.Run("dotnet", []string{path}, timeout: TimeSpan.FromSeconds(30))
            Assert.False(result.TimedOut, result.Output)
            Assert.True(result.ExitCode == 0, result.Output)
            Assert.Empty(result.Stderr)
            return result.Stdout
        }

        private const Source string = `
#nullable enable
public static class P
{
    static int reads;
    static T Read<T>(T value) { reads++; return value; }
    static string IsNull<T>(T value) => (value is null).ToString();
    public static string Run<T>(T replacement, bool flag, bool clear)
    {
        T seed = replacement;
        string result = "";
        int count = 0;
        do
        {
            var a = seed;
            var b = seed;
            var joined = flag ? a : b;
            result += IsNull(joined) + ":";
            seed = clear ? default(T) : flag ? a : b;
        } while (++count < 2);
        return result;
    }
    public static string Value<T>(T replacement, bool flag)
    {
        T storage = default(T);
        var empty = flag ? storage : storage;
        storage = empty;
        return "zero=" + (storage is null ? "null" : storage.ToString());
    }
    public static void Main()
    {
        foreach (bool flag in new[] { true, false })
        foreach (bool clear in new[] { true, false })
        {
            System.Console.WriteLine(Run("value", flag, clear));
            System.Console.WriteLine(Run<string?>(null, flag, clear));
            System.Console.WriteLine(Run(7, flag, clear));
        }
        System.Console.WriteLine(Value(7, true));
        System.Console.WriteLine(Value(7, false));
        System.Console.WriteLine(Value("value", true));
        System.Console.WriteLine(Value("value", false));
        System.Console.WriteLine("reads=" + reads);
    }
}`
    }
}
