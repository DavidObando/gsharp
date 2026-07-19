// <copyright file="Issue2500NullableExplicitGenericArgumentsTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2500NullableExplicitGenericArgumentsTranslationTests
{
    [Fact]
    public void SemanticTypeArguments_PreserveNullableWrappersAcrossCallAndTypeShapes()
    {
        string printed = Translate("""
            #nullable enable
            using System;
            using System.Collections.Generic;
            using System.Threading.Tasks;

            namespace Demo;

            public interface IContract
            {
            }

            public class Base
            {
            }

            public sealed class Host
            {
                public TArg Instance<TArg>(TArg value) => value;
            }

            public static class Extensions
            {
                public static TArg Reduced<TArg>(this Host host, TArg value) => value;
            }

            public sealed class LocalBox<TArg>
            {
                public LocalBox(TArg value)
                {
                }

                public static LocalBox<TArg> Create(TArg value) => new(value);
            }

            public static class Repro
            {
                private static TArg Same<TArg>(TArg value) => value;
                private static void Pair<TFirst, TSecond>(TFirst first, TSecond second)
                {
                }

                public static void Run<T, TClass, TInterface, TBase, TValue>(Host host)
                    where TClass : class
                    where TInterface : IContract
                    where TBase : Base
                    where TValue : struct
                {
                    T? Factory() => default;

                    _ = Same<T?>(default);
                    _ = Same<TClass?>(default);
                    _ = Same<TInterface?>(default);
                    _ = Same<TBase?>(default);
                    _ = Same<TValue?>(default);
                    _ = External.Sink.Echo<T?>(default);
                    _ = Task.FromResult<T?>(default);
                    _ = host.Instance<T?>(default);
                    _ = host.Reduced<T?>(default);
                    _ = Extensions.Reduced<T?>(host, default);
                    _ = Same<List<T?>?>(default);
                    _ = Same<Dictionary<T?, List<T?[]?>?>?>(default);
                    Pair<T?, List<T?>?>(default, default);
                    _ = Same<(T?, TClass?)>(default);
                    _ = Same<T?[]?>(default);
                    _ = Same<Func<T?>?>(Factory);
                    _ = new LocalBox<T?>(default);
                    _ = new External.Box<T?>(default);
                    _ = LocalBox<T?>.Create(default);
                    _ = External.Box<T?>.Create(default);
                }

            #nullable disable
                public static void Oblivious<T>()
                {
                    _ = Same<T>(default);
                    _ = External.Sink.Echo<T>(default);
                }
            #nullable restore
            }
            """);

        Assert.Contains("Same[T?](default(T?))", printed, StringComparison.Ordinal);
        Assert.Contains("Same[TClass?](default(TClass?))", printed, StringComparison.Ordinal);
        Assert.Contains("Same[TInterface?](default(TInterface?))", printed, StringComparison.Ordinal);
        Assert.Contains("Same[TBase?](default(TBase?))", printed, StringComparison.Ordinal);
        Assert.Contains("Same[TValue?](default(TValue?))", printed, StringComparison.Ordinal);
        Assert.Contains("Echo[T?](default(T?))", printed, StringComparison.Ordinal);
        Assert.Contains("Task.FromResult[T?](default(T?))", printed, StringComparison.Ordinal);
        Assert.Contains("host.Instance[T?](default(T?))", printed, StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(printed, "host.Reduced[T?](default(T?))"));
        Assert.Contains("Same[List[T?]?](default(List[T?]?))", printed, StringComparison.Ordinal);
        Assert.Contains(
            "Same[Dictionary[T?, List[[]?T?]?]?](default(Dictionary[T?, List[[]?T?]?]?))",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("Pair[T?, List[T?]?](default(T?), default(List[T?]?))", printed, StringComparison.Ordinal);
        Assert.Contains("Same[(T?, TClass?)](default((T?, TClass?)))", printed, StringComparison.Ordinal);
        Assert.Contains("Same[[]?T?](default([]?T?))", printed, StringComparison.Ordinal);
        Assert.Contains("Same[(() -> T?)?](Factory)", printed, StringComparison.Ordinal);
        Assert.Contains("LocalBox[T?](default(T?))", printed, StringComparison.Ordinal);
        Assert.Contains("Box[T?](default(T?))", printed, StringComparison.Ordinal);
        Assert.Contains("LocalBox[T?].Create(default(T?))", printed, StringComparison.Ordinal);
        Assert.Contains("Box[T?].Create(default(T?))", printed, StringComparison.Ordinal);
        Assert.Contains("Same[T](default(T))", printed, StringComparison.Ordinal);
        Assert.Contains("Echo[T](default(T))", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void UsingAliases_PreserveNullableSemanticArguments()
    {
        string printed = Translate("""
            #nullable enable
            using TaskAlias = System.Threading.Tasks.Task;
            using ExternalAlias = External.Sink;
            using ClosedBoxAlias = External.Box<string?>;

            namespace Demo;

            public static class Repro
            {
                public static void Run<T>()
                {
                    _ = TaskAlias.FromResult<T?>(default);
                    _ = ExternalAlias.Echo<T?>(default);
                    _ = new ClosedBoxAlias(default);
                }
            }
            """);

        Assert.Contains("TaskAlias.FromResult[T?](default(T?))", printed, StringComparison.Ordinal);
        Assert.Contains("ExternalAlias.Echo[T?](default(T?))", printed, StringComparison.Ordinal);
        Assert.Contains("Box[string?](default(string?))", printed, StringComparison.Ordinal);
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        int index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }

    private static string Translate(string source)
    {
        MetadataReference external = CreateExternalReference();
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Issue2500.Consumer",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Concat(new[] { external }).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        var document = new LoadedDocument("Snippet.cs", tree, compilation.GetSemanticModel(tree));
        var context = new TranslationContext(compilation, document.SemanticModel, document.FilePath);
        return GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static MetadataReference CreateExternalReference()
    {
        const string source = """
            #nullable enable

            namespace External;

            public sealed class Box<T>
            {
                public Box(T value)
                {
                }

                public static Box<T> Create(T value) => new(value);
            }

            public static class Sink
            {
                public static T Echo<T>(T value) => value;
            }
            """;

        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: "External.cs");
        var compilation = CSharpCompilation.Create(
            "Issue2500.External",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        using var stream = new MemoryStream();
        var emit = compilation.Emit(stream);
        Assert.True(
            emit.Success,
            "External sink must compile: " + string.Join(Environment.NewLine, emit.Diagnostics));
        return MetadataReference.CreateFromImage(stream.ToArray());
    }
}
