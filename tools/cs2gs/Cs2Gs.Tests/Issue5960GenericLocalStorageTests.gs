// <copyright file="Issue5960GenericLocalStorageTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import System
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks
import Xunit
import Xunit.Abstractions

open class Issue5960GenericLocalStorageTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData("exact")
    @InlineData("effectful")
    @InlineData("fixed-consumers")
    @InlineData("captured")
    @InlineData("lambda-result")
    @InlineData("alias-result")
    @InlineData("fixed-loop")
    @InlineData("iterator-result")
    @InlineData("repeated-arguments")
    async func ExplicitGenericStorage_PreservesNativeRuntimeBytes(shape string) {
        let effectful = shape == "effectful"
        let fixedConsumers = shape == "fixed-consumers"
        let loopCase = shape == "exact" || effectful || shape == "captured" || shape == "fixed-loop"
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
            let source = if fixedConsumers {
                FixedConsumerSource
            } else if shape == "lambda-result" {
                LambdaResultSource
            } else if shape == "alias-result" {
                AliasResultSource
            } else if shape == "iterator-result" {
                IteratorResultSource
            } else if shape == "repeated-arguments" {
                RepeatedArgumentsSource
            } else if shape == "fixed-loop" {
                Source.Replace("T seed = replacement;", "T seed = replacement; _ = IsNull<T>(seed);")
            } else if shape == "captured" {
                Source.Replace("string result = \"\";", "System.Func<string> loop = () => { string result = \"\";")
                    .Replace("return result;", "return result; }; return loop();")
            } else if effectful {
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
            if fixedConsumers {
                Assert.Equal(string.Concat(Enumerable.Repeat("True:0" + Environment.NewLine, 5)), expected)
            } else if shape == "lambda-result" || shape == "alias-result" {
                Assert.Equal("True:0" + Environment.NewLine, expected)
            } else if shape == "iterator-result" {
                Assert.Equal("True" + Environment.NewLine + "0" + Environment.NewLine, expected)
            } else if shape == "repeated-arguments" {
                Assert.Equal(
                    "False:False" + Environment.NewLine + string.Concat(
                        Enumerable.Repeat("True:True" + Environment.NewLine, 3)
                    ),
                    expected
                )
            } else {
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
            }

            let destination = Path.Combine(directory, "translated")
            let cli = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(compiler))!!, "Cs2Gs.Cli", "cs2gs.dll")
            Assert.True(File.Exists(cli), "Build the real cs2gs CLI before running this test.")
            let translation = await ProcessRunner.RunAsync(
                "dotnet",
                []string{
                    cli,
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
                },
                timeout: TimeSpan.FromSeconds(45)
            )
            Assert.False(translation.TimedOut, translation.Output)
            Assert.True(translation.ExitCode == 0, translation.Output)
            let translated = Directory.GetFiles(destination, "Probe.gs", SearchOption.AllDirectories)
            let gsPath = Assert.Single(translated)
            let printed = File.ReadAllText(gsPath)
            Assert.True(!translation.Output.Contains("CS2GS-GENERIC-STORE-BRIDGE"), translation.Output + "\n" + printed)
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
            if fixedConsumers {
                Assert.DoesNotContain("value T?", printed)
                Assert.DoesNotContain("!!", printed)
            } else if loopCase && shape != "fixed-loop" {
                Assert.Contains("var seed T?", printed)
                Assert.DoesNotContain("seed!!", printed)
            } else {
                Assert.DoesNotContain("!!", printed)
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ExplicitGenericLocals_IndexIdentifierAndSymbolScanWorkOnce(hasDefault bool) {
        var previous int64 = 0
        for count in[]int32{64, 128, 256} {
            let declarations = StringBuilder()
            let observations = StringBuilder()
            for var i = 0; i < count; i++ {
                declarations.AppendLine("T value$i = ${if hasDefault { "default(T)" } else { "replacement" }};")
                if hasDefault {
                    declarations.AppendLine("var alias$i = value$i; value$i = alias$i;")
                }
                if i > 0 {
                    observations.Append(" + ")
                }
                observations.Append("IsNull(value$i)")
            }
            let source = "#nullable enable\npublic static class P {\n" +
                "static string IsNull<T>(T value) => (value is null).ToString();\n" +
                "public static string Run<T>(T replacement) {\n" +
                declarations.ToString() + "System.Func<string> observe = () => " + observations.ToString() +
                ";\nreturn observe();\n} }"
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Scale.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let translator = CSharpToGSharpTranslator()
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            TranslationTestValidation.AssertBinds(printed)
            let work = translator.LastLocalStorageScanWork
            this.output.WriteLine("$count locals, default=$hasDefault: $work identifier/symbol/read scan steps")
            Assert.True(work > 0, "The resource oracle must count full identifier and symbol scans.")
            if previous > 0 {
                Assert.True(
                    work <= previous * 3,
                    "Doubling explicit generic locals must retain linear scan work: $previous -> $work."
                )
            }
            previous = work
        }
    }

    shared {
        private const LambdaResultSource string = `
#nullable enable
public static class P
{
    static System.Func<T> Make<T>() { T value = default(T); return () => value; }
    public static void Main()
    {
        System.Console.WriteLine((Make<string>()() is null) + ":" + Make<int>()());
    }
}`

        private const AliasResultSource string = `
#nullable enable
public static class P
{
    static T Make<T>() { T value = default(T); T result = value; return result; }
    public static void Main()
    {
        System.Console.WriteLine((Make<string>() is null) + ":" + Make<int>());
    }
}`

        private const IteratorResultSource string = `
#nullable enable
public static class P
{
    static System.Collections.Generic.IEnumerable<T> Make<T>() { T value = default(T); yield return value; }
    public static void Main()
    {
        foreach (var value in Make<string>()) System.Console.WriteLine(value is null);
        foreach (var value in Make<int>()) System.Console.WriteLine(value);
    }
}`

        private const RepeatedArgumentsSource string = `
#nullable enable
public static class P
{
    static string Pair<U>(U a, U b) => (a is null) + ":" + (b is null);
    static string FixedPair<U>(U[] carrier, U a, U b) => Pair(a, b);
    static string RefPair<U>(ref U a, U b) => Pair(a, b);
    static string Run<T>(T p) where T : class { T x = p; return Pair(x, x); }
    static string Defaults<T>() where T : class { T x = default(T); return Pair(x, x); }
    static string Fixed<T>() where T : class
    {
        T x = default(T);
        return FixedPair(new T[1], x, x);
    }
    static string Propagate<T>() where T : class
    {
        T x = default(T);
        T y = default(T);
        _ = Pair(y, y);
        var result = RefPair(ref x, y);
        _ = Pair<T>(x, x);
        return result;
    }
    public static void Main()
    {
        System.Console.WriteLine(Run("value"));
        System.Console.WriteLine(Defaults<string>());
        System.Console.WriteLine(Fixed<string>());
        System.Console.WriteLine(Propagate<string>());
    }
}`

        private const FixedConsumerSource string = `
#nullable enable
public static class P
{
    static bool IsNull<T>(T value) => value is null;
    static T Identity<T>(T value) => value;
    static T Make<T>() { T value = default(T); return value; }
    static T Select<T>(bool flag) { T value = default(T); return flag ? value : value; }
    static T Pass<T>() { T value = default(T); return Identity<T>(value); }
    static T Reset<T>() { T value = default(T); value = default(T); return value; }
    public static void Main()
    {
        System.Console.WriteLine(IsNull(Make<string>()) + ":" + Make<int>());
        System.Console.WriteLine(IsNull(Select<string>(true)) + ":" + Select<int>(true));
        System.Console.WriteLine(IsNull(Select<string>(false)) + ":" + Select<int>(false));
        System.Console.WriteLine(IsNull(Pass<string>()) + ":" + Pass<int>());
        System.Console.WriteLine(IsNull(Reset<string>()) + ":" + Reset<int>());
    }
}`

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
