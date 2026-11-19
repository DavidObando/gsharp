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
    @InlineData("assignment-result")
    @InlineData("inferred-call-result")
    @InlineData("out-parameter")
    @InlineData("projected-containers")
    @InlineData("async-projected")
    @InlineData("object-alias")
    @InlineData("ref-choose-projected")
    @InlineData("extension-receiver")
    @InlineData("nullable-alias-assignment")
    @InlineData("projected-indexer")
    @InlineData("deep-projected-depth")
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
            } else if shape == "assignment-result" {
                AssignmentResultSource
            } else if shape == "inferred-call-result" {
                InferredCallResultSource
            } else if shape == "out-parameter" {
                OutParameterSource
            } else if shape == "projected-containers" {
                ProjectedContainersSource
            } else if shape == "async-projected" {
                AsyncProjectedSource
            } else if shape == "object-alias" {
                ObjectAliasSource
            } else if shape == "ref-choose-projected" {
                RefChooseProjectedSource
            } else if shape == "extension-receiver" {
                ExtensionReceiverSource
            } else if shape == "nullable-alias-assignment" {
                NullableAliasAssignmentSource
            } else if shape == "projected-indexer" {
                ProjectedIndexerSource
            } else if shape == "deep-projected-depth" {
                DeepProjectedDepthSource
            } else if shape == "fixed-loop" {
                ConstrainedSource
                    .Replace(
                    "RunRef<T>(T replacement, bool flag, bool clear) where T : class?",
                    "RunRef<T>(T replacement, bool flag, bool clear)"
                )
                    .Replace(
                    "RunVal<T>(T replacement, bool flag, bool clear) where T : struct",
                    "RunVal<T>(T replacement, bool flag, bool clear)"
                )
                    .Replace("T seed = replacement;", "T seed = replacement; _ = IsNull<T>(seed);")
            } else if shape == "captured" {
                ConstrainedSource.Replace(
                    "string result = \"\";",
                    "System.Func<string> loop = () => { string result = \"\";"
                )
                    .Replace("return result;", "return result; }; return loop();")
            } else if effectful {
                ConstrainedSource.Replace("T seed = replacement;", "T seed = Read(replacement);").Replace(
                    "seed = clear ? default(T) : flag ? a : b;",
                    "seed = clear ? default(T) : Read(flag ? a : b);"
                )
            } else {
                ConstrainedSource
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
            } else if shape == "assignment-result" {
                Assert.Equal(string.Concat(Enumerable.Repeat("True:0" + Environment.NewLine, 3)), expected)
            } else if shape == "inferred-call-result" {
                Assert.Equal(
                    string.Concat(Enumerable.Repeat("True:0" + Environment.NewLine, 4)) +
                        "True:True:True" +
                        Environment.NewLine,
                    expected
                )
            } else if shape == "out-parameter" {
                Assert.Equal(
                    string.Concat(Enumerable.Repeat("True:0" + Environment.NewLine, 2)) + "done" + Environment.NewLine,
                    expected
                )
            } else if shape == "projected-containers" {
                Assert.Equal("1:True:1:True:1:True:True:True:True:True:True:1:True" + Environment.NewLine, expected)
            } else if shape == "async-projected" {
                Assert.Equal("True:1:True:1:True:True:1:True" + Environment.NewLine, expected)
            } else if shape == "object-alias" {
                Assert.Equal("1:True" + Environment.NewLine, expected)
            } else if shape == "ref-choose-projected" {
                Assert.Equal("True:True:True" + Environment.NewLine, expected)
            } else if shape == "extension-receiver" {
                Assert.Equal("True:True:True:True:0" + Environment.NewLine, expected)
            } else if shape == "nullable-alias-assignment" {
                Assert.Equal("keep:ok:True:True" + Environment.NewLine, expected)
            } else if shape == "projected-indexer" {
                Assert.Equal("True:True:True:True:True" + Environment.NewLine, expected)
            } else if shape == "deep-projected-depth" {
                Assert.Equal("True" + Environment.NewLine, expected)
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
            if shape != "nullable-alias-assignment" {
                Assert.True(
                    !translation.Output.Contains("CS2GS-GENERIC-STORE-BRIDGE"),
                    translation.Output + "\n" + printed
                )
            }
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
            } else if shape == "assignment-result" {
                Assert.DoesNotContain("left T?", printed)
                Assert.DoesNotContain("right T?", printed)
                Assert.DoesNotContain("!!", printed)
            } else if shape == "inferred-call-result" {
                Assert.Contains("let kept T? = default(T)", printed)
                Assert.DoesNotContain("value T?", printed)
                Assert.DoesNotContain("!!", printed)
            } else if shape == "out-parameter" {
                Assert.DoesNotContain("value T?", printed)
                Assert.DoesNotContain("!!", printed)
            } else if shape == "projected-containers" ||
                shape == "async-projected" ||
                shape == "ref-choose-projected" ||
                shape == "projected-indexer" {
                Assert.Contains("let kept T? = default(T)", printed)
                Assert.DoesNotContain("value T?", printed)
                Assert.DoesNotContain("!!", printed)
            } else if shape == "deep-projected-depth" {
                Assert.DoesNotContain("value T?", printed)
                Assert.DoesNotContain("!!", printed)
            } else if shape == "object-alias" {
                Assert.Contains("let value T? = default(T)", printed)
                Assert.DoesNotContain("!!", printed)
            } else if shape == "extension-receiver" {
                Assert.DoesNotContain("value T?", printed)
                Assert.DoesNotContain("!!", printed)
            } else if shape == "nullable-alias-assignment" {
                Assert.Contains("let y = input", printed)
                Assert.Contains("x = y!!", printed)
                Assert.Contains("var alias T? = value", printed)
                Assert.Contains("alias = input", printed)
                Assert.DoesNotContain("value T?", printed)
                Assert.DoesNotContain("input!!", printed)
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

    @Fact
    func UnrestrictedGenericLocalStorage_PreservesContractAndReceivesGS0641() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", Source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translator = CSharpToGSharpTranslator()
        let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
        Assert.Contains("var seed T? = replacement", printed)
        Assert.Contains("let a T? = seed", printed)
        Assert.Contains("let b T? = seed", printed)
        Assert.Contains("let joined T? = if flag { a } else { b }", printed)
        Assert.Contains("var storage T? = default(T)", printed)
        Assert.Contains("let empty T? = if flag { storage } else { storage }", printed)
        Assert.DoesNotContain("!!", printed)
        TranslationTestValidation.AssertSourceNullableKindRejection(printed, "T")
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
                "public static string Run<T>(T replacement) where T : class {\n" +
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

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ExplicitGenericAliasChains_KeepLinearContractWork(branching bool) {
        var previous int64 = 0
        for count in[]int32{64, 128, 256} {
            let declarations = StringBuilder()
            declarations.AppendLine("var x0 = replacement;")
            let observations = StringBuilder()
            observations.Append("Id<T>(x0)")
            for var i = 1; i < count; i++ {
                let previousName = "x${i - 1}"
                if branching {
                    declarations.AppendLine("var x$i = flag ? $previousName : $previousName;")
                } else {
                    declarations.AppendLine("var x$i = $previousName;")
                }
                observations.Append(" + \":\" + Id<T>(x$i)")
            }
            let source = "#nullable enable\npublic static class P {\n" +
                "static string Id<U>(U value) => (value is null).ToString();\n" +
                "public static string Run<T>(T replacement, bool flag) where T : class {\n" +
                declarations.ToString() + "return " + observations.ToString() + ";\n} }"
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("AliasChain.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let translator = CSharpToGSharpTranslator()
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            TranslationTestValidation.AssertBinds(printed)
            Assert.DoesNotContain("!!", printed)
            let work = translator.LastLocalStorageScanWork
            this.output.WriteLine("$count aliases, branching=$branching: $work contract scan steps")
            Assert.True(work > 0, "The resource oracle must count bare-contract alias checks.")
            if previous > 0 {
                Assert.True(
                    work <= previous * 3,
                    "Doubling alias chain length must retain linear contract work: $previous -> $work."
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

        private const AssignmentResultSource string = `
#nullable enable
public static class P
{
    static T Identity<T>(T value) => value;
    static T Make<T>() { T left = default(T); T right = default(T); return (left = right); }
    static T MakeChained<T>() { T a = default(T); T b = default(T); T c = default(T); return (a = (b = c)); }
    static T MakeViaPass<T>() { T left = default(T); T right = default(T); return Identity<T>(left = right); }
    public static void Main()
    {
        System.Console.WriteLine((Make<string>() is null) + ":" + Make<int>());
        System.Console.WriteLine((MakeChained<string>() is null) + ":" + MakeChained<int>());
        System.Console.WriteLine((MakeViaPass<string>() is null) + ":" + MakeViaPass<int>());
    }
}`

        private const InferredCallResultSource string = `
#nullable enable
public static class P
{
    static U Id<U>(U x) => x;
    static bool IsNull<U>(U x) => x is null;
    static System.Collections.Generic.IEnumerable<U> SeqId<U>(U x) { yield return x; }
    static T Make<T>() { T value = default(T); return Id(value); }
    static T MakeNested<T>() { T value = default(T); return Id(Id(value)); }
    static T MakeAlias<T>() { T value = default(T); T copy = Id(value); return copy; }
    static System.Collections.Generic.IEnumerable<T> MakeSeq<T>() { T value = default(T); return SeqId(value); }
    static bool PreservesNull<T>() where T : class { T kept = default(T); return Id(kept) is null; }
    static T? PreservesNullableReturn<T>() where T : class { T kept = default(T); return Id(kept); }
    static bool PreservesChainedNull<T>() where T : class { T kept = default(T); return IsNull(Id(kept)); }
    public static void Main()
    {
        System.Console.WriteLine((Make<string>() is null) + ":" + Make<int>());
        System.Console.WriteLine((MakeNested<string>() is null) + ":" + MakeNested<int>());
        System.Console.WriteLine((MakeAlias<string>() is null) + ":" + MakeAlias<int>());
        bool? seqRef = null;
        foreach (var item in MakeSeq<string>()) seqRef = item is null;
        int seqVal = -1;
        foreach (var item in MakeSeq<int>()) seqVal = item;
        System.Console.WriteLine(seqRef + ":" + seqVal);
        System.Console.WriteLine(PreservesNull<string>() + ":" + (PreservesNullableReturn<string>() is null) + ":" + PreservesChainedNull<string>());
    }
}`

        private const OutParameterSource string = `
#nullable enable
public static class P
{
    static void MakeOut<T>(out T result) { T value = default(T); result = value; }
    static void MakeRef<T>(ref T result) { T value = default(T); result = value; }
    static string TouchByVal<T>(T target) { T value = default(T); target = value; return "done"; }
    public static void Main()
    {
        MakeOut<string>(out var outRef);
        MakeOut<int>(out var outVal);
        System.Console.WriteLine((outRef is null) + ":" + outVal);
        string refText = "keep";
        int refNum = 7;
        MakeRef(ref refText);
        MakeRef(ref refNum);
        System.Console.WriteLine((refText is null) + ":" + refNum);
        System.Console.WriteLine(TouchByVal("ok"));
    }
}`

        private const ProjectedContainersSource string = `
#nullable enable
public static class P
{
    sealed class Outer<O>
    {
        public sealed class Item
        {
            public O Value { get; }
            public Item(O value) { Value = value; }
        }
    }
    static System.Collections.Generic.List<U> Wrap<U>(U x) => new System.Collections.Generic.List<U> { x };
    static (U, U) Pair<U>(U x) => (x, x);
    static B Second<A, B>((A, B) x) => x.Item2;
    static Outer<V>.Item Box<V>(V x) => new Outer<V>.Item(x);
    static (V, V, V, V, V, V, V, V, V) Repeat9<V>(V x) => (x, x, x, x, x, x, x, x, x);
    static System.Collections.Generic.List<T> MakeInferredLocalList<T>() where T : class
    {
        T value = default(T);
        var result = Wrap(value);
        return result;
    }
    static System.Collections.Generic.List<System.Collections.Generic.List<T>> MakeNestedList<T>() where T : class
    {
        T value = default(T);
        return Wrap(Wrap(value));
    }
    static System.Collections.Generic.List<System.Collections.Generic.List<T>> MakeChainedNestedList<T>() where T : class
    {
        T value = default(T);
        var inner = Wrap(value);
        return Wrap(inner);
    }
    static T MakeSecond<T>() where T : class
    {
        T value = default(T);
        return Second(Pair(value));
    }
    static T? MakeSecondNullable<T>() where T : class
    {
        T kept = default(T);
        return Second(Pair(kept));
    }
    static Outer<System.Collections.Generic.List<T>>.Item MakeBoxedList<T>() where T : class
    {
        T value = default(T);
        return Box(Wrap(value));
    }
    static (
        System.Collections.Generic.List<T>,
        System.Collections.Generic.List<T>,
        System.Collections.Generic.List<T>,
        System.Collections.Generic.List<T>,
        System.Collections.Generic.List<T>,
        System.Collections.Generic.List<T>,
        System.Collections.Generic.List<T>,
        System.Collections.Generic.List<T>,
        System.Collections.Generic.List<T>) MakeRepeat9Wrap<T>() where T : class
    {
        T value = default(T);
        return Repeat9(Wrap(value));
    }
    static (
        System.Collections.Generic.List<T?>,
        System.Collections.Generic.List<T?>,
        System.Collections.Generic.List<T?>,
        System.Collections.Generic.List<T?>,
        System.Collections.Generic.List<T?>,
        System.Collections.Generic.List<T?>,
        System.Collections.Generic.List<T?>,
        System.Collections.Generic.List<T?>,
        System.Collections.Generic.List<T?>) MakeRepeat9WrapNullable<T>() where T : class
    {
        T kept = default(T);
        return Repeat9(Wrap(kept));
    }
    static System.Collections.Generic.List<T?> MakeNullableList<T>() where T : class
    {
        T kept = default(T);
        var result = Wrap(kept);
        return result;
    }
    public static void Main()
    {
        var single = MakeInferredLocalList<string>();
        var nested = MakeNestedList<string>();
        var chained = MakeChainedNestedList<string>();
        var second = MakeSecond<string>();
        var secondNullable = MakeSecondNullable<string>();
        var boxed = MakeBoxedList<string>();
        var repeat9 = MakeRepeat9Wrap<string>();
        var repeat9Nullable = MakeRepeat9WrapNullable<string>();
        var nullable = MakeNullableList<string>();
        System.Console.WriteLine(
            single.Count + ":" + (single[0] is null) + ":" +
            nested.Count + ":" + (nested[0][0] is null) + ":" +
            chained.Count + ":" + (chained[0][0] is null) + ":" +
            (second is null) + ":" + (secondNullable is null) + ":" +
            (boxed.Value[0] is null) + ":" +
            (repeat9.Item9[0] is null) + ":" +
            (repeat9Nullable.Item9[0] is null) + ":" +
            nullable.Count + ":" + (nullable[0] is null));
    }
}`

        private const AsyncProjectedSource string = `
#nullable enable
public static class P
{
    static async System.Threading.Tasks.Task<U> Echo<U>(U x)
    {
        await System.Threading.Tasks.Task.Yield();
        return x;
    }
    static async System.Threading.Tasks.Task<System.Collections.Generic.List<U>> WrapAsync<U>(U x)
    {
        await System.Threading.Tasks.Task.Yield();
        return new System.Collections.Generic.List<U> { x };
    }
    static System.Threading.Tasks.Task<T> MakeUnawaitedTask<T>() where T : class
    {
        T value = default(T);
        return Echo(value);
    }
    static async System.Threading.Tasks.Task<System.Collections.Generic.List<T>> MakeAwaitedList<T>() where T : class
    {
        T value = default(T);
        return await WrapAsync(value);
    }
    static async System.Threading.Tasks.Task<System.Collections.Generic.List<T>> MakeParenthesizedAwaitedList<T>() where T : class
    {
        T value = default(T);
        return await (WrapAsync(value));
    }
    static System.Threading.Tasks.Task<T?> MakeUnawaitedNullableTask<T>() where T : class
    {
        T kept = default(T);
        return Echo(kept);
    }
    static async System.Threading.Tasks.Task<System.Collections.Generic.List<T?>> MakeAwaitedNullableList<T>() where T : class
    {
        T kept = default(T);
        return await WrapAsync(kept);
    }
    public static void Main()
    {
        var t1 = MakeUnawaitedTask<string>().GetAwaiter().GetResult();
        var t2 = MakeAwaitedList<string>().GetAwaiter().GetResult();
        var t2p = MakeParenthesizedAwaitedList<string>().GetAwaiter().GetResult();
        var t3 = MakeUnawaitedNullableTask<string>().GetAwaiter().GetResult();
        var t4 = MakeAwaitedNullableList<string>().GetAwaiter().GetResult();
        System.Console.WriteLine(
            (t1 is null) + ":" +
            t2.Count + ":" + (t2[0] is null) + ":" +
            t2p.Count + ":" + (t2p[0] is null) + ":" +
            (t3 is null) + ":" +
            t4.Count + ":" + (t4[0] is null));
    }
}`

        private const ObjectAliasSource string = `
#nullable enable
public static class P
{
    static System.Collections.Generic.List<U> Wrap<U>(U x) => new System.Collections.Generic.List<U> { x };
    static object Make<T>() where T : class
    {
        T value = default(T);
        var a = (object)Wrap(value);
        a = Wrap(a);
        return a;
    }
    public static void Main()
    {
        var outer = (System.Collections.IList)Make<string>();
        if (outer[0] is System.Collections.IList inner)
        {
            System.Console.WriteLine(outer.Count + ":" + (inner[0] is null));
        }
    }
}`

        private const RefChooseProjectedSource string = `
#nullable enable
public static class P
{
    static System.Collections.Generic.List<U> Wrap<U>(U x) => new System.Collections.Generic.List<U> { x };
    static V Choose<V>(ref V seed, System.Collections.Generic.List<V> values) => values.Count > 0 ? values[0] : seed;
    static void Touch<V>(ref V seed, System.Collections.Generic.List<V> values) { }
    static T MakeChoose<T>(T replacement) where T : class
    {
        T seed = replacement;
        T value = default(T);
        return Choose(ref seed, Wrap(value));
    }
    static T MakeTouchFixed<T>(T replacement) where T : class
    {
        T seed = replacement;
        T value = default(T);
        Touch(ref seed, Wrap(value));
        return value;
    }
    static T? MakeTouchNullable<T>() where T : class
    {
        T seed = default(T);
        T kept = default(T);
        Touch(ref seed, Wrap(kept));
        return kept;
    }
    public static void Main()
    {
        System.Console.WriteLine(
            (MakeChoose("keep") is null) + ":" +
            (MakeTouchFixed("keep") is null) + ":" +
            (MakeTouchNullable<string>() is null));
    }
}`

        private const ExtensionReceiverSource string = `
#nullable enable
public static class Ext
{
    public static U Id<U>(this U x) => x;
}
public static class P
{
    static T Make<T>() where T : class
    {
        T value = default(T);
        return value.Id();
    }
    static T MakeStatic<T>() where T : class
    {
        T value = default(T);
        return Ext.Id(value);
    }
    static T MakeStaticUnconstrained<T>()
    {
        T value = default(T);
        return Ext.Id(value);
    }
    static T MakeUnconstrained<T>()
    {
        T value = default(T);
        return value.Id();
    }
    public static void Main()
    {
        System.Console.WriteLine(
            (Make<string>() is null) + ":" +
            (MakeStatic<string>() is null) + ":" +
            (MakeStaticUnconstrained<string>() is null) + ":" +
            (MakeUnconstrained<string>() is null) + ":" +
            MakeUnconstrained<int>());
    }
}`

        private const NullableAliasAssignmentSource string = `
#nullable enable
public static class P
{
    static T Make<T>(T replacement, T? input, bool clear) where T : class
    {
        T x = clear ? default(T) : replacement;
        var y = input;
        if (x is null) x = y;
        return x;
    }
    static bool MakeUnfixed<T>(T? input) where T : class
    {
        T x = default(T);
        var y = input;
        if (x is null) x = y;
        return x is null;
    }
    static T MakeSubsequentAliasWrite<T>(T? input) where T : class
    {
        T value = default(T);
        var alias = value;
        alias = input;
        return value;
    }
    public static void Main()
    {
        System.Console.WriteLine(
            Make("keep", null, false) + ":" +
            Make("keep", "ok", true) + ":" +
            MakeUnfixed<string>(null) + ":" +
            (MakeSubsequentAliasWrite<string>("ok") is null));
    }
}`

        private const ProjectedIndexerSource string = `
#nullable enable
public static class P
{
    sealed class Boxed<B>
    {
        public B Value { get; }
        public Boxed(B value) { Value = value; }
    }
    static System.Collections.Generic.List<U> Wrap<U>(U x) => new System.Collections.Generic.List<U> { x };
    static Boxed<U> Box<U>(U x) => new Boxed<U>(x);
    static T MakeIndexer<T>() where T : class
    {
        T value = default(T);
        var items = Wrap(value);
        return items[0];
    }
    static T MakeDirectIndexer<T>() where T : class
    {
        T value = default(T);
        return Wrap(value)[0];
    }
    static T MakeItemAliasIndexer<T>() where T : class
    {
        T value = default(T);
        var items = Wrap(value);
        var item = items[0];
        return item;
    }
    static T MakeBoxMember<T>() where T : class
    {
        T value = default(T);
        var box = Box(value);
        return box.Value;
    }
    static T? MakeNullableIndexer<T>() where T : class
    {
        T kept = default(T);
        var items = Wrap(kept);
        return items[0];
    }
    public static void Main()
    {
        System.Console.WriteLine(
            (MakeIndexer<string>() is null) + ":" +
            (MakeDirectIndexer<string>() is null) + ":" +
            (MakeItemAliasIndexer<string>() is null) + ":" +
            (MakeBoxMember<string>() is null) + ":" +
            (MakeNullableIndexer<string>() is null));
    }
}`

        private const DeepProjectedDepthSource string = `
#nullable enable
public static class P
{
    static System.Collections.Generic.List<U> Wrap<U>(U x) => new System.Collections.Generic.List<U> { x };
    static System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<
        System.Collections.Generic.List<T>>>>>>>>>>>>>>>>> MakeDeep<T>() where T : class
    {
        T value = default(T);
        var result = Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(Wrap(value)))))))))))))))));
        return result;
    }
    public static void Main()
    {
        var deep = MakeDeep<string>();
        System.Console.WriteLine(deep[0][0][0][0][0][0][0][0][0][0][0][0][0][0][0][0][0] is null);
    }
}`

        private const ConstrainedSource string = `
#nullable enable
public static class P
{
    static int reads;
    static T Read<T>(T value) { reads++; return value; }
    static string IsNull<T>(T value) => (value is null).ToString();
    public static string RunRef<T>(T replacement, bool flag, bool clear) where T : class?
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
    public static string RunVal<T>(T replacement, bool flag, bool clear) where T : struct
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
    public static string ValueRef<T>(T replacement, bool flag) where T : class
    {
        T storage = default(T);
        var empty = flag ? storage : storage;
        storage = empty;
        return "zero=" + (storage is null ? "null" : storage.ToString());
    }
    public static string ValueVal<T>(T replacement, bool flag) where T : struct
    {
        T storage = default(T);
        var empty = flag ? storage : storage;
        storage = empty;
        return "zero=" + ((object?)storage is null ? "null" : storage.ToString());
    }
    public static void Main()
    {
        foreach (bool flag in new[] { true, false })
        foreach (bool clear in new[] { true, false })
        {
            System.Console.WriteLine(RunRef("value", flag, clear));
            System.Console.WriteLine(RunRef<string?>(null, flag, clear));
            System.Console.WriteLine(RunVal(7, flag, clear));
        }
        System.Console.WriteLine(ValueVal(7, true));
        System.Console.WriteLine(ValueVal(7, false));
        System.Console.WriteLine(ValueRef("value", true));
        System.Console.WriteLine(ValueRef("value", false));
        System.Console.WriteLine("reads=" + reads);
    }
}`

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
