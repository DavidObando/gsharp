// <copyright file="Issue4679NestedImportedDelegateIdentityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Abstractions;

namespace Cs2Gs.Tests;

[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue4679NestedImportedDelegateIdentityTranslationTests
{
    private const string Contracts = """
        #nullable enable
        using System;

        namespace Issue4679.Contracts
        {
            public class Outer<T>
            {
                public delegate string Callback<U>(T outer, U value);
                public delegate T Plain(T value);

                public class Middle<V>
                {
                    public delegate string Callback<W>(T outer, V middle, W value);
                }

                public class Bridge
                {
                    public delegate string Callback<U>(T outer, U value);
                }
            }

            public class Other<T>
            {
                public delegate string Callback<U>(T outer, U value);
            }

            public static class NativeFactory
            {
                public static Outer<string>.Callback<int> Generic() => (outer, value) => outer + ":" + value;
                public static Outer<string>.Plain Plain() => value => value;
                public static Outer<int>.Callback<string> Distinct() => (outer, value) => outer + ":" + value;
                public static Other<string>.Callback<int> Other() => (outer, value) => outer + ":" + value;
                public static Outer<string>.Middle<double>.Callback<int> Deep() =>
                    (outer, middle, value) => outer + ":" + (int)middle + ":" + value;
                public static Outer<string>.Bridge.Callback<int> Bridge() => (outer, value) => outer + ":" + value;
                public static Outer<string>.Callback<(string, int)> Tuple() =>
                    (outer, value) => outer + ":" + value.Item1 + ":" + value.Item2;
                public static Outer<string>.Callback<int[]> Array() => (outer, value) => outer + ":" + value.Length;
                public static global::Issue4679.@class.@event<string>.Callback<int> Escaped() =>
                    (outer, value) => outer + ":" + value;
                public static global::System.DelegateContracts.Outer<string>.Callback<int> Alias() =>
                    (outer, value) => outer + ":" + value;
            }
        }

        namespace Issue4679.@class
        {
            public class @event<T>
            {
                public delegate T Callback<U>(T value, U other);
            }
        }

        namespace System.DelegateContracts
        {
            public class Outer<T>
            {
                public delegate string Callback<U>(T outer, U value);
            }
        }
        """;

    private readonly ITestOutputHelper output;

    public Issue4679NestedImportedDelegateIdentityTranslationTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Theory]
    [InlineData("Outer<string>.Callback<int>", "Issue4679.Contracts.Outer[string].Callback[int32]", "Generic", "\"outer\", 7", "outer:7")]
    [InlineData("Outer<string>.Plain", "Issue4679.Contracts.Outer[string].Plain", "Plain", "\"plain\"", "plain")]
    [InlineData("Outer<int>.Callback<string>", "Issue4679.Contracts.Outer[int32].Callback[string]", "Distinct", "7, \"inner\"", "7:inner")]
    [InlineData("Other<string>.Callback<int>", "Issue4679.Contracts.Other[string].Callback[int32]", "Other", "\"other\", 9", "other:9")]
    [InlineData("Outer<string>.Middle<double>.Callback<int>", "Issue4679.Contracts.Outer[string].Middle[float64].Callback[int32]", "Deep", "\"outer\", 2.5, 7", "outer:2:7")]
    [InlineData("Outer<string>.Bridge.Callback<int>", "Issue4679.Contracts.Outer[string].Bridge.Callback[int32]", "Bridge", "\"bridge\", 7", "bridge:7")]
    [InlineData("Outer<string>.Callback<(string, int)>", "Issue4679.Contracts.Outer[string].Callback[(string, int32)]", "Tuple", "\"outer\", (\"item\", 2)", "outer:item:2")]
    [InlineData("Outer<string>.Callback<int[]>", "Issue4679.Contracts.Outer[string].Callback[[]int32]", "Array", "\"outer\", new int[] { 1, 2 }", "outer:2")]
    [InlineData("Issue4679.@class.@event<string>.Callback<int>", "$event[string].Callback[int32]", "Escaped", "\"escaped\", 7", "escaped:7")]
    [InlineData("System.DelegateContracts.Outer<string>.Callback<int>", "DelegateContractsOuter[string].Callback[int32]", "Alias", "\"alias\", 7", "alias:7")]
    public void ImportedNestedDelegate_PreservesOwnerAndOwnArguments_CompilesVerifiesAndRuns(
        string type,
        string renderedType,
        string factory,
        string arguments,
        string expected)
    {
        string compiler = LocalFunctionHoistTranslationTests.FindCompiler();
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        Assert.NotNull(compiler);
        Assert.NotNull(repoRoot);
        Assert.NotEqual("1", Environment.GetEnvironmentVariable(IlVerifyRunner.SkipEnvVar));
        this.output.WriteLine("Loaded mapper SHA256=" + Hash(typeof(CSharpTypeMapper).Assembly.Location));
        this.output.WriteLine("Final test DLL SHA256=" + Hash(typeof(Issue4679NestedImportedDelegateIdentityTranslationTests).Assembly.Location));

        string directory = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", "issue4679", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string contractsPath = Path.Combine(directory, "Contracts.dll");
            string translatedPath = Path.Combine(directory, "Consumer.dll");
            string callerPath = Path.Combine(directory, "NativeConsumer.dll");
            CompileCSharp(contractsPath, Contracts);
            string qualifiedType = type.StartsWith("Issue4679.", StringComparison.Ordinal)
                || type.StartsWith("System.", StringComparison.Ordinal)
                ? "global::" + type
                : "global::Issue4679.Contracts." + type;
            string source = Consumer(qualifiedType, factory, arguments);
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[] { ("Consumer.cs", source) },
                CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(contractsPath)).ToArray());
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
            LoadedDocument document = Assert.Single(project.Documents);
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
            this.output.WriteLine("FULL translated consumer:\n" + printed);
            string sourcePath = Path.Combine(directory, "Consumer.gs");
            File.WriteAllText(sourcePath, printed);
            ProcessRunResult compile = ProcessRunner.Run(
                "dotnet",
                new[] { compiler, "/target:library", "/out:" + translatedPath, "/r:" + contractsPath, sourcePath });
            Assert.False(compile.TimedOut, compile.Output);
            Assert.True(compile.ExitCode == 0, compile.Output + "\n" + printed);
            Assert.Contains("Echo(value " + renderedType + ") " + renderedType, printed, StringComparison.Ordinal);
            Assert.Contains("delegate First_Callback[U]", printed, StringComparison.Ordinal);
            Assert.Contains("delegate Second_Callback[U]", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("First.Callback", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("Second.Callback", printed, StringComparison.Ordinal);
            Assert.Contains("() -> " + renderedType, printed, StringComparison.Ordinal);
            CompileCSharp(callerPath, NativeConsumer(qualifiedType, factory, expected), contractsPath, translatedPath);

            string[] assemblies = { contractsPath, translatedPath, callerPath };
            foreach (string assembly in assemblies)
            {
                this.VerifyStrictly(repoRoot, assembly, assemblies);
            }

            var loadContext = new AssemblyLoadContext("Issue4679-" + Guid.NewGuid().ToString("N"), isCollectible: true);
            try
            {
                foreach (string assembly in assemblies)
                {
                    using var image = new MemoryStream(File.ReadAllBytes(assembly));
                    Assembly loaded = loadContext.LoadFromStream(image);
                    if (assembly == callerPath)
                    {
                        Type caller = loaded.GetType("NativeConsumer", throwOnError: true);
                        MethodInfo run = caller.GetMethod("Run");
                        Assert.NotNull(run);
                        Assert.Equal(expected, run.Invoke(null, null));
                        this.output.WriteLine("Native consumption, invocation, casts, reflection, containers, nullability and source-owned controls passed: " + expected);
                    }
                }
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string Consumer(string type, string factory, string arguments) => $$"""
        #nullable enable
        using System;
        using System.Collections.Generic;
        using Issue4679.Contracts;

        namespace Consumer
        {
            public sealed class Outer { }
            public sealed class Other { }

            public sealed class Probe
            {
                public {{type}} Echo({{type}} value) => value;
                public {{type}}? EchoNullable({{type}}? value) => value;
                public {{type}} Make() => NativeFactory.{{factory}}();
                public {{type}} Cast(object value) => ({{type}})value;
                public {{type}}? Safe(object value) => value as {{type}};
                public bool Matches(object value) => value is {{type}};
                public Type Observe() => typeof({{type}});
                public Type Infer<T>(T value) => typeof(T);
                public Type Inferred() => Infer(NativeFactory.{{factory}}());
                public string Invoke({{type}} value) => value({{arguments}});
                public {{type}}[] EchoArray({{type}}[] values) => values;
                public List<{{type}}> EchoList(List<{{type}}> values) => values;
                public ({{type}}, int) Pair({{type}} value) => (value, 7);
                public Func<{{type}}> EchoFunc(Func<{{type}}> value) => value;
                public string InvokeFunc(Func<{{type}}> value) => value()({{arguments}});
                public global::Issue4679.Contracts.Outer<T>.Callback<U> Open<T, U>(
                    global::Issue4679.Contracts.Outer<T>.Callback<U> value) => value;
                public global::Issue4679.Contracts.Outer<T>.Middle<V>.Callback<U> OpenDeep<T, V, U>(
                    global::Issue4679.Contracts.Outer<T>.Middle<V>.Callback<U> value) => value;
            }

            public sealed class First<T>
            {
                public delegate U Callback<U>(U value);
                public Callback<int> Echo(Callback<int> value) => value;
                public int Invoke(Callback<int> value) => value(7);
            }

            public sealed class Second<T>
            {
                public delegate U Callback<U>(U value);
                public Callback<int> Echo(Callback<int> value) => value;
                public int Invoke(Callback<int> value) => value(7);
            }
        }
        """;

    private static string NativeConsumer(string type, string factory, string expected) => $$"""
        #nullable enable
        using System;
        using System.Collections.Generic;
        using System.Linq;
        using System.Reflection;
        using Consumer;
        using Issue4679.Contracts;

        public static class NativeConsumer
        {
            public static string Run()
            {
                var probe = new Probe();
                {{type}} value = NativeFactory.{{factory}}();
                {{type}} made = probe.Make();
                object boxed = value;
                Func<{{type}}> function = NativeFactory.{{factory}};
                var methods = typeof(Probe).GetMethods();
                if (methods.Length == 0
                    || typeof(Probe).GetMethod("Echo")?.ReturnType != typeof({{type}})
                    || typeof(Probe).GetMethod("Echo")?.GetParameters().Single().ParameterType != typeof({{type}})
                    || probe.Observe() != typeof({{type}})
                    || probe.Inferred() != typeof({{type}})
                    || made.GetType() != typeof({{type}}))
                {
                    throw new Exception("Containing/own argument metadata or exact CLR identity changed.");
                }

                var nullability = new NullabilityInfoContext();
                var nullable = typeof(Probe).GetMethod("EchoNullable") ?? throw new Exception("Missing nullable method.");
                if (nullability.Create(nullable.ReturnParameter).ReadState != NullabilityState.Nullable
                    || nullability.Create(nullable.GetParameters().Single()).ReadState != NullabilityState.Nullable
                    || probe.EchoNullable(null) != null)
                {
                    throw new Exception("Annotated nullable delegate contract changed.");
                }

                if (!ReferenceEquals(value, probe.Echo(value))
                    || !ReferenceEquals(value, probe.Cast(boxed))
                    || !ReferenceEquals(value, probe.Safe(boxed))
                    || !probe.Matches(boxed)
                    || probe.Matches(new Func<string, int>(text => text.Length))
                    || probe.Safe(new object()) != null
                    || probe.Invoke(made) != "{{expected}}"
                    || probe.InvokeFunc(function) != "{{expected}}"
                    || !ReferenceEquals(function, probe.EchoFunc(function)))
                {
                    throw new Exception("Native consumption, invocation or cast/pattern identity changed.");
                }

                var array = new {{type}}[] { value };
                var list = new List<{{type}}> { value };
                var pair = probe.Pair(value);
                if (!ReferenceEquals(array, probe.EchoArray(array))
                    || !ReferenceEquals(list, probe.EchoList(list))
                    || !ReferenceEquals(value, pair.Item1) || pair.Item2 != 7)
                {
                    throw new Exception("Nested array/list/tuple delegate identity changed.");
                }

                var generic = NativeFactory.Generic();
                var deep = NativeFactory.Deep();
                if (!ReferenceEquals(generic, probe.Open<string, int>(generic))
                    || !ReferenceEquals(deep, probe.OpenDeep<string, double, int>(deep))
                    || typeof(Probe).GetMethod("Open")?.GetGenericArguments().Length != 2
                    || typeof(Probe).GetMethod("OpenDeep")?.GetGenericArguments().Length != 3)
                {
                    throw new Exception("Open containing/own generic argument metadata changed.");
                }

                First_Callback<int> first = number => number + 1;
                Second_Callback<int> second = number => number + 2;
                if (!ReferenceEquals(first, new First<string>().Echo(first))
                    || !ReferenceEquals(second, new Second<string>().Echo(second))
                    || new First<string>().Invoke(first) != 8 || new Second<string>().Invoke(second) != 9
                    || typeof(First_Callback<int>) == typeof(Second_Callback<int>))
                {
                    throw new Exception("Source-owned lifted delegate policy changed.");
                }

                return "{{expected}}";
            }
        }
        """;

    private static void CompileCSharp(string path, string source, params string[] references)
    {
        CSharpCompilation compilation = CSharpCompilation.Create(
            Path.GetFileNameWithoutExtension(path),
            new[] { CSharpSyntaxTree.ParseText(source, path: "Fixture.cs") },
            CSharpProjectLoader.RuntimeReferences().Concat(references.Select(reference => MetadataReference.CreateFromFile(reference))),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithDeterministic(true));
        using var image = File.Create(path);
        var result = compilation.Emit(image);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private void VerifyStrictly(string repoRoot, string path, IReadOnlyList<string> assemblies)
    {
        var arguments = new List<string>
        {
            "tool", "run", "ilverify", path, "-s", "System.Private.CoreLib", "--verbose",
        };
        foreach (string reference in Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll").Concat(assemblies))
        {
            arguments.Add("-r");
            arguments.Add(reference);
        }

        ProcessRunResult result = ProcessRunner.Run("dotnet", arguments, workingDirectory: repoRoot);
        this.output.WriteLine("STRICT UNSUPPRESSED ILVerify " + Path.GetFileName(path) + ":\n" + result.Output);
        Assert.False(result.TimedOut, result.Output);
        Assert.True(result.ExitCode == 0, result.Output);
        Assert.Contains("All Classes and Methods", result.Output, StringComparison.Ordinal);
        Assert.DoesNotContain("[IL]: Error", result.Output, StringComparison.Ordinal);
    }

    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
}
