// <copyright file="Issue4816SelfMigrationNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4816SelfMigrationNullabilityTests
{
    [Theory]
    [InlineData(NullableContextOptions.Disable)]
    public void NullableLocals_PreserveMaybeNullRuntimeValues(
        NullableContextOptions nullableContext)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText("""
            using System;
            using System.IO;

            #nullable disable
            public static class Fixture
            {
                private static string ReadMaybeNull() => null;

                public static void Run()
                {
                    string evidence = Environment.GetEnvironmentVariable("GSHARP_EVIDENCE");
                    if (!string.IsNullOrEmpty(evidence))
                    {
                        _ = Path.Combine(evidence, "result");
                    }

                    string current = "/";
                    string parent = Path.GetDirectoryName(current);
                    if (string.IsNullOrEmpty(parent))
                    {
                        _ = parent;
                    }

                    string promoted = ReadMaybeNull();
                    if (string.IsNullOrEmpty(promoted))
                    {
                        _ = promoted;
                    }
                }
            }
            """, path: "Fixture.cs");
        var compilation = CSharpCompilation.Create(
            "Issue4816.NullableLocals",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(nullableContext));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument(tree.FilePath, tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains(
            """let evidence string? = Environment.GetEnvironmentVariable("GSHARP_EVIDENCE")""",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains(
            """let parent string? = Path.GetDirectoryName(current)""",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains(
            """let promoted string? = ReadMaybeNull()""",
            rendered,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ObliviousReads_KeepTheirNonNullUseSitesWhenSelfMigrated()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Fixture.cs", """
                #nullable disable
                using System;
                using System.Collections.Generic;
                using System.IO;
                using System.Linq;
                using System.Reflection;

                public static class Fixture
                {
                    private static string Accept(string value) => value;
                    private static Node Merge(Node left, Node right) => left;
                    private static Node MergeParents(Node left, Node right) =>
                        left.Parent != null && right.Parent != null
                            ? Merge(left.Parent, right.Parent)
                            : left.Parent;
                    private static string[] Values() =>
                        new[] { typeof(string) }.Select(type => type.FullName).ToArray();

                    public static void Run(string[] values, MethodInfo[][] methods, bool include)
                    {
                        _ = Accept(values[0]);
                        var projected = Values();
                        _ = Accept(projected[0]);
                        _ = Accept(projected.Single());
                        _ = Accept(Enumerable.Single(projected));
                        _ = Accept(projected.ToString());
                        _ = Accept(projected.Aggregate("seed", (acc, _) => acc));
                        string[] explicitProjected = Values();
                        _ = Accept(explicitProjected[0]);
                        _ = methods[0].Select(method => method.Name).ToArray();
                        _ = typeof(string).GetProperty("Length").GetValue("x").ToString();
                        _ = Convert.ToString(1);
                        _ = new { Name = "fixed" };
                        _ = new { Name = typeof(string).FullName };
                        _ = new { Values = Values() };
                        _ = new { Cast = (object)"fixed" as string };
                        _ = new { Cast = (string)null };
                        string maybe = null;
                        var nullableShape = new { Value = maybe };
                        var nonNullableShape = new { Value = "fixed" };
                        nullableShape = nonNullableShape;
                        string path = typeof(string).FullName;
                        _ = new { Path = path };
                        _ = new { Emitted = include ? new { Path = "fixed" } : null };
                        string evidence = Environment.GetEnvironmentVariable("GSHARP_EVIDENCE");
                        if (!string.IsNullOrEmpty(evidence))
                        {
                            _ = Path.Combine(evidence, "result");
                        }
                        string current = "/";
                        string parent = Path.GetDirectoryName(current);
                        if (string.IsNullOrEmpty(parent))
                        {
                            _ = parent;
                        }
                    }

                    private sealed class Node
                    {
                        public Node Parent { get; }
                    }
                }

                public class Outer<T>
                {
                    public class Inner
                    {
                        private readonly T value;
                        public Inner(T value) => this.value = value;
                        public T Get() => value;
                        public T[] GetValues() => new[] { value };
                    }
                }

                #nullable enable
                public static class AnnotatedFixture
                {
                    public static object Nullable(string? value, string?[] values) =>
                        new { Name = value, Values = values };
                    public static object NonNull(string value, string[] values) =>
                        new { Name = value, Values = values };
                    public static object DefaultValue(bool include) =>
                        new { Count = include ? default : 1 };
                    public static int MergedContractRead(string? maybe)
                    {
                        var nullableShape = new { Value = maybe };
                        var nonNullableShape = new { Value = "fixed" };
                        nullableShape = nonNullableShape;
                        return nonNullableShape.Value.Length;
                    }
                    public static bool MergedContractNullObservation(string? maybe)
                    {
                        var nonNullableShape = new { Value = "fixed" };
                        var nullableShape = new { Value = maybe };
                        nonNullableShape = nullableShape;
                        return nonNullableShape.Value == null;
                    }
                    public static object MergedDelegateContract(
                        Func<string?> nullableFactory,
                        Func<string> nonNullableFactory)
                    {
                        var nullableShape = new { Factory = nullableFactory };
                        var nonNullableShape = new { Factory = nonNullableFactory };
                        nullableShape = nonNullableShape;
                        return nullableShape;
                    }
                    public static int MergedContainingContract(
                        Outer<string>.Inner nonNullable,
                        Outer<string?>.Inner nullable)
                    {
                        var nonNullableShape = new { Value = nonNullable };
                        var nullableShape = new { Value = nullable };
                        nonNullableShape = nullableShape;
                        return nonNullableShape.Value.GetValues()[0].Length;
                    }
                    public static int MergedArrayElementRead(
                        string[] nonNullable,
                        string?[] nullable)
                    {
                        var nonNullableShape = new { Values = nonNullable };
                        var nullableShape = new { Values = nullable };
                        nonNullableShape = nullableShape;
                        return nonNullableShape.Values[0].Length;
                    }
                    public static int MergedGenericElementRead(
                        List<string> nonNullable,
                        List<string?> nullable)
                    {
                        var nonNullableShape = new { Values = nonNullable };
                        var nullableShape = new { Values = nullable };
                        nonNullableShape = nullableShape;
                        return nonNullableShape.Values[0].Length;
                    }
                }
                """),
        });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        Assert.DoesNotContain("""(nil as string)!!""", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("""Convert!!""", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("""projected.ToString()!!""", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("""projected.Aggregate("seed", (acc, _) -> acc)!!""", rendered, StringComparison.Ordinal);
        Assert.Contains("""let evidence string? = Environment.GetEnvironmentVariable("GSHARP_EVIDENCE")""", rendered, StringComparison.Ordinal);
        Assert.Contains("""let parent string? = Path.GetDirectoryName(current)""", rendered, StringComparison.Ordinal);
        Assert.Equal(
            """private func Merge(left Node, right Node) Node -> left""",
            rendered.Split('\n').Single(line => line.Contains("func Merge(", StringComparison.Ordinal)).Trim());
        Assert.DoesNotContain("""Merge(left Node?, right Node?)""", rendered, StringComparison.Ordinal);
        Assert.Contains("""nonNullableShape.Value!!.Length""", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ProjectedArrayReturn_UsesTheCallingDocumentLocation()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Producer.cs", "#nullable disable\n" + new string(' ', 500) + """
                using System;
                using System.Linq;
                public static class Producer
                {
                    public static string[] Values() =>
                        new[] { typeof(string) }.Select(type => type.FullName).ToArray();
                }
                """),
            ("Consumer.cs", """
                #nullable disable
                public static class Consumer
                {
                    public static int Read() => Producer.Values()[0].Length;
                }
                """),
        });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        LoadedDocument producer = project.Documents.Single(
            candidate => candidate.FilePath.EndsWith("Producer.cs", StringComparison.Ordinal));
        var producerContext = new TranslationContext(
            project.Compilation,
            producer.SemanticModel,
            producer.FilePath);
        string producerRendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(producer, producerContext));
        LoadedDocument document = project.Documents.Single(
            candidate => candidate.FilePath.EndsWith("Consumer.cs", StringComparison.Ordinal));
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("""Producer.Values()[0]!!.Length""", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(producerRendered, rendered);
    }

    [Fact]
    public void NullableRecordEnvelope_DoesNotWidenStoredMembers()
    {
        var library = CSharpCompilation.Create(
            "Issue4816.Options",
            new[]
            {
                CSharpSyntaxTree.ParseText("""
                    #nullable disable
                    public sealed class Options
                    {
                        public string SourceRoot { get; set; }
                        public string OutputRoot { get; set; }
                    }
                    """),
            },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var image = new MemoryStream();
        var emit = library.Emit(image);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics));

        IReadOnlyList<MetadataReference> references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromImage(image.ToArray()))
            .ToList();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Fixture.cs", """
                #nullable disable
                public readonly record struct Arguments(Options Options, string Path);

                public static class Fixture
                {
                    private static Arguments? Parse()
                    {
                        var options = new Options();
                        _ = options == null;
                        return new(options, null);
                    }

                    public static void Run()
                    {
                        Arguments? parsed = Parse();
                        if (parsed == null)
                        {
                            return;
                        }

                        var (options, _) = parsed.Value;
                        options.SourceRoot = "source";
                    }
                }
                """),
        }, references);
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            new[] { project.Compilation, library },
            new[] { project.Compilation, library });
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("""Options Options""", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("""Options Options?""", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedGenericSubstitution_PreservesNullableValueContract()
    {
        var library = CSharpCompilation.Create(
            "Issue4816.Imported",
            new[]
            {
                CSharpSyntaxTree.ParseText("""
                    #nullable enable
                    public sealed class Box<T>
                    {
                        public T Value { get; }
                        public Box(T value) => Value = value;
                    }
                    public static class Factory
                    {
                        public static Box<string?> Create() => new(null);
                    }
                    """),
            },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var image = new MemoryStream();
        var emit = library.Emit(image);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics));

        IReadOnlyList<MetadataReference> references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromImage(image.ToArray()))
            .ToList();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("Consumer.cs", """
                    #nullable disable
                    public static class Consumer
                    {
                        public static int Read() => Factory.Create().Value.Length;
                    }
                    """),
            },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("""Factory.Create().Value!!.Length""", rendered, StringComparison.Ordinal);
    }
}
