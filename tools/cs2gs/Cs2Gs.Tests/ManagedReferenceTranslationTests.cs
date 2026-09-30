// <copyright file="ManagedReferenceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class ManagedReferenceTranslationTests
{
    [Fact]
    public void DefaultInitializedManagedReferenceArraysUseNullableElements()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayTranslation;
            public class Probe {
                public static int Run() {
                    int[] values = { 3, 4 };
                    var retained = new ManagedRef<int>[2];
                    retained[0] = ManagedRef<int>.FromArray(values, 0);
                    var retainedAlias = retained;
                    var readOnly = new ReadOnlyManagedRef<int>[2];
                    readOnly[1] = ReadOnlyManagedRef<int>.FromArray(values, 1);
                    return retainedAlias[0].Borrow() + readOnly[1].Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrays.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("let retained = [2]managed[int32]?", text);
        Assert.Contains("let readOnly = [2]readonly managed[int32]?", text);
        Assert.Contains("retainedAlias[0]!!.Borrow()", text);
        Assert.Contains("readOnly[1]!!.Borrow()", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void DefaultInitializedJaggedManagedReferenceArraysWidenEveryEnclosingElement()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedJaggedArrayTranslation;
            public class Probe {
                public static int Run() {
                    var managed = new ManagedRef<int>[1][];
                    var ordinary = new int[1][];
                    return managed[0] == null && ordinary.Length == 1 ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedJaggedArrays.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "let managed = [1][]?Gsharp.Values.ManagedRef[int32]?",
            text,
            StringComparison.Ordinal);
        Assert.Contains("let ordinary = [1][]int32", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void DefaultInitializedManagedReferenceTupleArraysWidenTupleLeaves()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedTupleArrayTranslation;
            public class Probe {
                public static int Run() {
                    var pairs = new (ManagedRef<int> Reference, int Value)[1];
                    return pairs[0].Reference == null && pairs[0].Value == 0 ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedTupleArrays.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Reference managed[int32]?", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void DeconstructedForEachUsesProjectedManagedReferenceTupleLeaves()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedTupleArrayForEachTranslation;
            public class Probe {
                private static int ReadPair(
                    ((ManagedRef<int> Reference, int NestedValue) Pair, int Value)[] pairs) {
                    foreach (var item in pairs) {
                        return item.Pair.Reference.Borrow();
                    }
                    return 0;
                }

                private static int ReadDeconstructed(
                    ((ManagedRef<int> Reference, int NestedValue) Pair, int Value)[] pairs) {
                    foreach (var (pair, _) in pairs) {
                        return pair.Reference.Borrow();
                    }
                    return 0;
                }

                public static int Run() {
                    int[] values = { 42 };
                    var pairs =
                        new ((ManagedRef<int> Reference, int NestedValue) Pair, int Value)[1];
                    pairs[0] = ((ManagedRef<int>.FromArray(values, 0), 1), 2);
                    return ReadPair(pairs) + ReadDeconstructed(pairs);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedTupleArrayForEach.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("item.Pair.Reference!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(84, result.Value);
    }

    [Fact]
    public void DefaultInitializedManagedReferenceAggregateArraysFailLoudly()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedAggregateArrayTranslation;
            public struct Holder {
                public ManagedRef<int> Reference;
            }
            public class Probe {
                public static Holder[] Create() => new Holder[1];
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedAggregateArrays.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "managed-reference storage outside a tuple",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ManagedReferenceArraysUseNullableElementsAcrossStorageShapes()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayShapes;
            public class Probe {
                private static ManagedRef<int>[] field = new ManagedRef<int>[1];

                public static ManagedRef<int>[] Create() => new ManagedRef<int>[1];
                private static int Read(ManagedRef<int>[] items) => items[0].Borrow();
                private static int ReadRectangular(ReadOnlyManagedRef<int>[,] items) => items[0, 0].Borrow();

                public static int Run() {
                    int[] values = { 3, 4 };
                    field[0] = ManagedRef<int>.FromArray(values, 0);

                    ManagedRef<int>[] assigned;
                    assigned = new ManagedRef<int>[1];
                    assigned[0] = ManagedRef<int>.FromArray(values, 1);

                    var returned = Create();
                    returned[0] = ManagedRef<int>.FromArray(values, 0);

                    var rectangular = new ReadOnlyManagedRef<int>[1, 1];
                    rectangular[0, 0] = ReadOnlyManagedRef<int>.FromArray(values, 1);

                    return Read(field)
                        + Read(assigned)
                        + Read(returned)
                        + ReadRectangular(rectangular);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayShapes.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("[1]managed[int32]?", text);
        Assert.Contains("func Create() []managed[int32]?", text);
        Assert.Contains("[1, 1]readonly managed[int32]?", text);
        Assert.Contains("items[0]!!.Borrow()", text);
        Assert.Contains("items[0, 0]!!.Borrow()", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(14, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayInitializersPreserveNilElements()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayInitializers;
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var vector = new ManagedRef<int>[] { source[0] };
                    var implicitVector = new[] { source[0] };
                    var rectangular = new ManagedRef<int>[1, 1] { { source[0] } };
                    ManagedRef<int>[] collection = [source[0]];
                    return vector[0] == null
                        && implicitVector[0] == null
                        && rectangular[0, 0] == null
                        && collection[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayInitializers.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NullableArrayInitializerPreservesReferenceConversion()
    {
        const string source = """
            namespace NullableArrayInitializerConversion;
            public class Base { }
            public class Derived : Base { }
            public class Probe {
                private static Derived? Maybe(bool present) => present ? new Derived() : null;
                public static int Run() {
                    var items = new Base?[] { Maybe(true), Maybe(false) };
                    return items[0] is Derived && items[1] == null ? 42 : 0;
                }
            }
            """;
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("NullableArrayInitializerConversion.cs", source) },
            CSharpProjectLoader.RuntimeReferences());
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NullableArrayReadsUseMappedElementNullability()
    {
        const string source = """
            namespace NullableArrayReads;
            public class Probe {
                public static int Run() {
                    string[] plain = { "y" };
                    string?[] source = { "x" };
                    var alias = source;
                    int total = plain[0].Length + (alias)[0].Length;
                    foreach (var item in (alias)) {
                        total += item.Length;
                    }
                    return total;
                }
            }
            """;
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("NullableArrayReads.cs", source) },
            CSharpProjectLoader.RuntimeReferences());
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("plain[0]!!", text, StringComparison.Ordinal);
        Assert.Contains("(alias)[0]!!.Length", text, StringComparison.Ordinal);
        Assert.Contains("item!!.Length", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayForEachBindingsRemainNullable()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayForEach;
            public class Probe {
                public static int Run() {
                    int[] values = { 3, 4 };
                    var source = new ManagedRef<int>[2];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    source[1] = ManagedRef<int>.FromArray(values, 1);
                    int total = 0;
                    foreach (var inferred in source) {
                        total += inferred.Borrow();
                    }
                    foreach (ManagedRef<int> explicitItem in source) {
                        total += explicitItem.Borrow();
                    }
                    return total;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayForEach.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.True(text.Contains("inferred!!.Borrow()", StringComparison.Ordinal), text);
        Assert.True(text.Contains("explicitItem!!.Borrow()", StringComparison.Ordinal), text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(14, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayForEachBindingDoesNotTaintShadowingParameter()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayForEachShadow;
            public class Probe {
                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    foreach (var item in source) {
                        static int Read(ManagedRef<int> item) => item.Borrow();
                        return Read(ManagedRef<int>.FromArray(values, 0));
                    }
                    return 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayForEachShadow.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("item!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ManagedReferenceListForEachBindingStaysNonNullable()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedListForEach;
            public class Probe {
                public static int Run() {
                    int[] values = { 3 };
                    var items = new List<ManagedRef<int>> {
                        ManagedRef<int>.FromArray(values, 0),
                    };
                    foreach (var item in items) {
                        return item.Borrow();
                    }
                    return 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedListForEach.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("item!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayElementWidensGenericContainer()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayGenericContainer;
            public class Holder<T> {
                public readonly T Value;
                public Holder(T value) { this.Value = value; }
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<ManagedRef<int>>(source[0]);
                    var list = new List<ManagedRef<int>>();
                    list.Add(source[0]);
                    return holder.Value == null && list[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayGenericContainer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Holder[managed[int32]?](source[0])", text, StringComparison.Ordinal);
        Assert.Contains("List[managed[int32]?]()", text, StringComparison.Ordinal);
        Assert.Contains("list.Add(source[0])", text, StringComparison.Ordinal);
        Assert.DoesNotContain("list.Add(source[0]!!)", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayCollectionInitializerWidensGenericContainer()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayCollectionInitializer;
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var values = new List<ManagedRef<int>> { source[0] };
                    return values[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayCollectionInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("List[managed[int32]?]{ source[0] }", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayObjectInitializerWidensGenericContainer()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayObjectInitializer;
            public sealed class Holder<T> {
                public T Field;
                public T Property { get; set; }
                public Holder(T value) {
                    Field = value;
                    Property = value;
                }
            }
            public class Probe {
                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<ManagedRef<int>>(
                        ManagedRef<int>.FromArray(values, 0)) {
                        Field = source[0],
                        Property = source[0],
                    };
                    return holder.Field == null && holder.Property == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayObjectInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Holder[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayElementProjectsStaticGenericTypeReceiver()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayStaticGenericReceiver;
            public sealed class Holder<T> {
                public static bool IsNil(T value) => value is null;
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return Holder<ManagedRef<int>>.IsNil(source[0]) ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayStaticGenericReceiver.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "Holder[managed[int32]?].IsNil(source[0])",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayElementDoesNotProjectFixedGenericStorage()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayFixedGenericStorage;
            public class Probe {
                private static readonly List<ManagedRef<int>> Items = new();

                private static int AddToParameter(
                    List<ManagedRef<int>> items,
                    ManagedRef<int>[] source) {
                    items.Add(source[0]);
                    return items[0].Borrow();
                }

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    Items.Add(source[0]);
                    return Items[0].Borrow()
                        + AddToParameter(new List<ManagedRef<int>>(), source);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedGenericStorage.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed receiver storage", StringComparison.Ordinal));
        Assert.Contains("Items.Add(source[0]!!)", text, StringComparison.Ordinal);
        Assert.Contains("items.Add(source[0]!!)", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayNilCannotSilentlyEnterFixedGenericStorage()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayFixedGenericStorageNil;
            public class Probe {
                private static readonly List<ManagedRef<int>> Items = new();

                private static void AddToParameter(
                    List<ManagedRef<int>> items,
                    ManagedRef<int>[] source) =>
                    items.Add(source[0]);

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    Items.Add(source[0]);
                    AddToParameter(new List<ManagedRef<int>>(), source);
                    return Items[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedGenericStorageNil.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed receiver storage", StringComparison.Ordinal));
        Assert.Contains("Items.Add(source[0]!!)", text, StringComparison.Ordinal);
        Assert.Contains("items.Add(source[0]!!)", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ManagedReferenceObjectCreationDoesNotProjectFixedDestinationStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayFixedObjectStorage;
            public sealed class Holder<T> {
                public readonly T Value;
                public Holder(T value) { Value = value; }
            }
            public class Probe {
                private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
                private static readonly Holder<ManagedRef<int>> Field =
                    new Holder<ManagedRef<int>>(Source[0]);
                private static Holder<ManagedRef<int>> Property { get; } =
                    new Holder<ManagedRef<int>>(Source[0]);

                private static Holder<ManagedRef<int>> Create() =>
                    new Holder<ManagedRef<int>>(Source[0]);

                private static bool IsNil(Holder<ManagedRef<int>> value) =>
                    value.Value == null;

                public static bool Run() =>
                    IsNil(new Holder<ManagedRef<int>>(Source[0]))
                    && Field.Value == null
                    && Property.Value == null
                    && Create().Value == null;
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedObjectStorage.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain("Holder[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.Contains("Holder[managed[int32]](Source[0]!!)", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text,
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ManagedReferenceArrayForEachBindingsBridgeEveryNonNullUse()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayForEachUses;
            public class Probe {
                private static int Read(ManagedRef<int> value) => value.Borrow();

                private static int Pass(ManagedRef<int>[] source) {
                    foreach (var item in source) {
                        return Read(item);
                    }
                    throw new Exception();
                }

                private static int Assign(ManagedRef<int>[] source) {
                    foreach (var item in source) {
                        ManagedRef<int> assigned = item;
                        return assigned.Borrow();
                    }
                    throw new Exception();
                }

                private static ManagedRef<int> Return(ManagedRef<int>[] source) {
                    foreach (var item in source) {
                        return item;
                    }
                    throw new Exception();
                }

                private static int Parenthesized(ManagedRef<int>[] source) {
                    foreach (var item in source) {
                        return (item).Borrow();
                    }
                    throw new Exception();
                }

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return Pass(source)
                        + Assign(source)
                        + Return(source).Borrow()
                        + Parenthesized(source);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayForEachUses.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Read(item!!)", text, StringComparison.Ordinal);
        Assert.Contains("assigned = item!!", text, StringComparison.Ordinal);
        Assert.Contains("return item!!", text, StringComparison.Ordinal);
        Assert.Contains("(item)!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void ForEachNullabilityTracksOnlyInferredBindings()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayForEachConversions;
            public class Probe {
                public static int Run() {
                    object?[] boxed = { 1 };
                    int convertedResult = 0;
                    foreach (int converted in boxed) {
                        convertedResult = converted.ToString() == "1" ? converted : 0;
                    }

                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    foreach (ManagedRef<int> managed in source) {
                        return convertedResult + managed.Borrow();
                    }
                    return 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayForEachConversions.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("converted!!", text, StringComparison.Ordinal);
        Assert.Contains("managed!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void ForEachTypeNamedVarRespectsElementConversion()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayNamedVarForEach;
            public sealed class var {
                public int Value;
                public static implicit operator var(ManagedRef<int> value) =>
                    new var { Value = value is null ? 42 : value.Borrow() };
            }
            public class Probe {
                public static int Run() {
                    ManagedRef<int>[] source = new ManagedRef<int>[1];
                    foreach (var item in source) {
                        return item.Value;
                    }
                    return 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNamedVarForEach.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("item!!.Value", text, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableValueArrayReadsAndForEachBindingsStayNullableValues()
    {
        const string source = """
            #nullable enable
            namespace NullableValueArrays;
            public class Probe {
                public static int Run() {
                    int?[] values = { 3 };
                    int total = values[0].GetValueOrDefault();
                    foreach (var item in values) {
                        total += item.GetValueOrDefault();
                    }
                    return total;
                }
            }
            """;
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("NullableValueArrays.cs", source) },
            CSharpProjectLoader.RuntimeReferences());
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("values[0]!!", text, StringComparison.Ordinal);
        Assert.DoesNotContain("item!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayGenericResultsKeepCSharpTypeArguments()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayGenericResults;
            public class Probe {
                private static T First<T>(T[] items) => items[0];
                private static int Read(ManagedRef<int> value) => value.Borrow();

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return First(source).Borrow()
                        + First<ManagedRef<int>>(source).Borrow()
                        + Read(First(source))
                        + Read(First<ManagedRef<int>>(source));
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayGenericResults.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("First(source)!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("First[managed[int32]?](source)!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("Read(First(source)!!)", text, StringComparison.Ordinal);
        Assert.Contains("Read(First[managed[int32]?](source)!!)", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayGenericExtensionsAndLocalFunctionsUseWidenedArguments()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayGenericCallShapes;
            public static class ManagedArrayExtensions {
                public static T First<T>(this T[] source) => source[0];
            }
            public class Probe {
                public static int Run() {
                    static T Recur<T>(T[] items, int depth) =>
                        depth == 0 ? items[0] : Recur<T>(items, depth - 1);

                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return ManagedArrayExtensions.First(source).Borrow()
                        + ManagedArrayExtensions.First<ManagedRef<int>>(source).Borrow()
                        + Recur(source, 1).Borrow()
                        + Recur<ManagedRef<int>>(source, 1).Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayGenericCallShapes.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        Assert.Contains("First[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.Contains("Recur[managed[int32]?]", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayGenericProjectionAndNestedResultsStayNullable()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayGenericNestedResults;
            public class Box<T> {
                public T Value;
                public Box(T value) { Value = value; }
            }
            public class Probe {
                private static Box<T> Wrap<T>(T[] items) => new Box<T>(items[0]);

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return source.First().Borrow()
                        + Wrap(source).Value.Borrow()
                        + Wrap<ManagedRef<int>>(source).Value.Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayGenericNestedResults.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("source.First()!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("Wrap(source).Value!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("Wrap[managed[int32]?](source).Value!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void ProjectedInferredLocalKeepsCompatibleReassignmentType()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayCompatibleLocalReassignment;
            public sealed class Holder<T> {
                public readonly T Value;
                public Holder(T value) { Value = value; }
            }
            public class Probe {
                private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var holder = Wrap(source);
                    holder = Wrap(source);
                    return holder.Value.Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayCompatibleLocalReassignment.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("holder.Value!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ProjectedInferredLocalRejectsIncompatibleReassignmentType()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayMixedLocalReassignment;
            public sealed class Holder<T> {
                public readonly T Value;
                public Holder(T value) { Value = value; }
            }
            public class Probe {
                private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
                private static Holder<ManagedRef<int>> Fixed(ManagedRef<int> value) =>
                    new Holder<ManagedRef<int>>(value);

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    var holder = Wrap(source);
                    holder = Fixed(ManagedRef<int>.FromArray(values, 0));
                    return holder.Value.Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayMixedLocalReassignment.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain("var holder Holder[managed[int32]?]", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ProjectedInferredLocalRejectsFixedValueConsumers()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayFixedLocalConsumer;
            public sealed class Holder<T> {
                public T Value;
            }
            public class Probe {
                private static Holder<ManagedRef<int>> Fixed;
                private static void Use(Holder<ManagedRef<int>> holder) { }

                public static void Pass() {
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<ManagedRef<int>>();
                    Use(holder);
                    holder.Value = source[0];
                }

                public static void Assign() {
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<ManagedRef<int>>();
                    Fixed = holder;
                    holder.Value = source[0];
                }

                public static Holder<ManagedRef<int>> Return() {
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<ManagedRef<int>>();
                    holder.Value = source[0];
                    return holder;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedLocalConsumer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Equal(
            3,
            context.Diagnostics.Count(
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "fixed destination storage",
                    StringComparison.Ordinal)));
        Assert.DoesNotContain("var holder Holder[managed[int32]?]", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ProjectedReceiverResolvesConstructedGenericBase()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedBaseReceiver;
            public class Base<T> {
                public bool IsNil(T value) => value is null;
            }
            public sealed class Derived<T> : Base<T> {
            }
            public class Probe {
                private static Derived<T> Wrap<T>(T[] items) => new Derived<T>();

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return Wrap(source).IsNil(source[0]) ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedBaseReceiver.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Wrap(source).IsNil(source[0])", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ProjectedReceiverResolvesConstructedGenericInterface()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedInterfaceReceiver;
            public interface IConsumer<T> {
                bool IsNil(T value) => value is null;
            }
            public sealed class Consumer<T> : IConsumer<T> {
            }
            public class Probe {
                private static IConsumer<T> Wrap<T>(T[] items) => new Consumer<T>();

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return Wrap(source).IsNil(source[0]) ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedInterfaceReceiver.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Wrap(source).IsNil(source[0])", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ProjectedMethodResultDoesNotChangeFixedFieldStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayFixedMethodResult;
            public sealed class Holder<T> {
                public readonly T Value;
                public Holder(T value) { Value = value; }
            }
            public class Probe {
                private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
                private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
                private static readonly Holder<ManagedRef<int>> Field =
                    Wrap<ManagedRef<int>>(Source);
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedMethodResult.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain("Wrap[managed[int32]?](Source)", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ProjectedMethodResultDoesNotChangeFixedArrayElementStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayFixedArrayElementResult;
            public sealed class Holder<T> {
                public Holder(T value) { }
            }
            public class Probe {
                private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
                private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
                private static readonly Holder<ManagedRef<int>>[] Values = {
                    Wrap<ManagedRef<int>>(Source)
                };
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedArrayElementResult.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain("Wrap[managed[int32]?](Source)", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ProjectedMethodResultDoesNotChangeFixedCollectionElementStorage()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayFixedCollectionElementResult;
            public sealed class Holder<T> {
                public Holder(T value) { }
            }
            public class Probe {
                private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
                private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
                private static readonly List<Holder<ManagedRef<int>>> Values = new() {
                    Wrap<ManagedRef<int>>(Source)
                };
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedCollectionElementResult.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain("Wrap[managed[int32]?](Source)", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ProjectedMethodResultDoesNotChangeFixedTupleElementStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayFixedTupleElementResult;
            public sealed class Holder<T> {
                public Holder(T value) { }
            }
            public class Probe {
                private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
                private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
                private static readonly (Holder<ManagedRef<int>>, int) Pair =
                    (Wrap<ManagedRef<int>>(Source), 0);
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedTupleElementResult.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain("Wrap[managed[int32]?](Source)", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionFlowsThroughNestedArgumentTypes()
    {
        const string source = """
            using System;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayNestedArguments;
            public class Probe {
                private static IEnumerable<T> AsEnumerable<T>(T[] items) => items;
                private static T First<T>(IEnumerable<T> items) {
                    foreach (var item in items) {
                        return item;
                    }
                    throw new Exception();
                }

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return First(AsEnumerable(source)).Borrow()
                        + First<ManagedRef<int>>(AsEnumerable(source)).Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedArguments.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("First(AsEnumerable(source))!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains(
            "First[managed[int32]?](AsEnumerable(source))!!.Borrow()",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayGenericProjectionFlowsThroughMethodResults()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayGenericMethodResults;
            public class Box<T> {
                private readonly T value;
                public Box(T value) { this.value = value; }
                public T Get() => this.value;
            }
            public class Probe {
                private static Box<T> Wrap<T>(T[] items) => new Box<T>(items[0]);

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return Wrap(source).Get().Borrow()
                        + Wrap<ManagedRef<int>>(source).Get().Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayGenericMethodResults.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Wrap(source).Get()!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("Wrap[managed[int32]?](source).Get()!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayGenericArgumentsUseSubstitutedParameters()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayGenericArguments;
            public static class ManagedArrayExtensions {
                public static bool IsNil<T>(this T[] source, T value) => value is null;
            }
            public class Probe {
                private static bool Check<T>(T[] source, T value) => value is null;
                private static T First<T>(T[] source) => source[0];

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return Check<ManagedRef<int>>(source, source[0])
                        && Check<ManagedRef<int>>(source, First(source))
                        && source.IsNil(First(source))
                        && ManagedArrayExtensions.IsNil<ManagedRef<int>>(source, First(source))
                            ? 42
                            : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayGenericArguments.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        Assert.Contains("Check[managed[int32]?](source, source[0])", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        Assert.DoesNotContain("First(source)!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionAcceptsCompatibleInferredRefStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayCompatibleRefStorage;
            public class Probe {
                private static void CopyFirst<T>(T[] source, ref T value) =>
                    value = source[0];

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var value = source[0];
                    CopyFirst<ManagedRef<int>>(source, ref value);
                    return value == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayCompatibleRefStorage.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("CopyFirst[managed[int32]?](source, &value)", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionRejectsIncompatibleFixedRefStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayFixedRefStorage;
            public class Probe {
                private static void CopyRef<T>(T[] source, ref T value) =>
                    value = source[0];
                private static void CopyOut<T>(T[] source, out T output) =>
                    output = source[0];

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    ManagedRef<int> value = ManagedRef<int>.FromArray(values, 0);
                    ManagedRef<int> output;
                    CopyRef<ManagedRef<int>>(source, ref value);
                    CopyOut<ManagedRef<int>>(source, out output);
                    return value.Borrow() + output.Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedRefStorage.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Equal(
            2,
            context.Diagnostics.Count(diagnostic =>
                diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("by-reference storage", StringComparison.Ordinal)));
        Assert.DoesNotContain("CopyRef[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.DoesNotContain("CopyOut[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.Contains("CopyRef[managed[int32]](source, &value)", text, StringComparison.Ordinal);
        Assert.Contains(
            "CopyOut[managed[int32]](source, out output)",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ManagedReferenceArrayElementRejectsNonNullableRefParameter()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayElementRefStorage;
            public class Probe {
                private static void Set(ref ManagedRef<int> value) { }

                public static void Run() {
                    var source = new ManagedRef<int>[1];
                    Set(ref source[0]);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayElementRefStorage.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("by-reference storage", StringComparison.Ordinal));
    }

    [Fact]
    public void ManagedReferenceArrayExpandedParamsUseSubstitutedElementContract()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayGenericParams;
            public class Probe {
                private static bool AllNil<T>(T[] source, params T[] values) =>
                    values[0] is null && values[1] is null;

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return AllNil<ManagedRef<int>>(source, source[0], source[0])
                        && AllNil<ManagedRef<int>>(
                            source,
                            values: new ManagedRef<int>[] { source[0], source[0] })
                            ? 42
                            : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayGenericParams.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayParamsOnlyCallsUseNullableElementContract()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayParamsOnly;
            public class Probe {
                private static bool FirstNil<T>(params T[] values) =>
                    values[0] is null;

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return FirstNil(source[0])
                        && FirstNil<ManagedRef<int>>(source[0])
                            ? 42
                            : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayParamsOnly.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("FirstNil(source[0])", text, StringComparison.Ordinal);
        Assert.Contains(
            "FirstNil[managed[int32]?](source[0])",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayReadOnlySpanParamsUsesNullableElementContract()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayReadOnlySpanParams;
            public class Probe {
                private static bool FirstNil<T>(params ReadOnlySpan<T> values) =>
                    values[0] is null;

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return FirstNil<ManagedRef<int>>(source[0]) ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayReadOnlySpanParams.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "FirstNil[managed[int32]?](source[0])",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayTargetTypedParamsCarrierIsNotExpanded()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayTargetTypedParams;
            public class Probe {
                private static bool Missing<T>(
                    T[] source,
                    params T[] values) =>
                    source[0] is null;

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return Missing<ManagedRef<int>>(source, default) ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayTargetTypedParams.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "default([]managed[int32]?)",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "default(managed[int32]?)",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ProjectionEligibilitySkipsOrdinaryCallsButKeepsManagedArrayCalls()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectionEligibility;
            public class Probe {
                private static int Twice(int value) => value * 2;
                private static T First<T>(T[] source) => source[0];

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return Twice(21) + (First(source) is null ? 0 : -42);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectionEligibility.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        IMethodSymbol[] invokedMethods = document.SyntaxTree.GetRoot()
            .DescendantNodes()
            .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax>()
            .Select(invocation =>
                document.SemanticModel.GetSymbolInfo(invocation).Symbol as IMethodSymbol)
            .Where(method => method != null)
            .ToArray();
        IMethodSymbol ordinaryMethod = Assert.Single(
            invokedMethods,
            method => method.Name == "Twice");
        IMethodSymbol managedArrayMethod = Assert.Single(
            invokedMethods,
            method => method.Name == "First");
        Assert.False(
            CSharpToGSharpTranslator.MethodMayRequireManagedReferenceArrayProjection(
                ordinaryMethod,
                project.Compilation));
        Assert.True(
            CSharpToGSharpTranslator.MethodMayRequireManagedReferenceArrayProjection(
                managedArrayMethod,
                project.Compilation));

        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("First(source)!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayAsSpanTracksProjectedCurrentType()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayPatternEnumerable;
            public class Probe {
                private static System.Span<T> AsSpan<T>(T[] items) => items.AsSpan();

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    foreach (var item in AsSpan(source)) {
                        return item.Borrow();
                    }
                    return 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayPatternEnumerable.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.True(
            text.Contains("item!!.Borrow()", StringComparison.Ordinal),
            text);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayNestedCollectionInitializerProjectsMemberContract()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayNestedCollectionInitializer;
            public sealed class Holder<T> {
                public List<T> Items { get; } = new();
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<ManagedRef<int>> {
                        Items = { source[0] },
                    };
                    return holder.Items[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedCollectionInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Holder[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayNestedObjectInitializerProjectsMemberContract()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayNestedObjectInitializer;
            public sealed class Box<T> {
                public T Value;
                public Box(T value) { Value = value; }
            }
            public sealed class Holder<T> {
                public Box<T> Item { get; }
                public Holder(T value) { Item = new Box<T>(value); }
            }
            public class Probe {
                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<ManagedRef<int>>(
                        ManagedRef<int>.FromArray(values, 0)) {
                        Item = { Value = source[0] },
                    };
                    return holder.Item.Value == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedObjectInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Holder[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayNestedGenericArgumentsProjectRecursively()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayNestedGenericArguments;
            public class Probe {
                private static T Echo<T>(T value) => value;

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var list = new List<ManagedRef<int>> { source[0] };
                    return Echo(list)[0].Borrow()
                        + Echo<List<ManagedRef<int>>>(list)[0].Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedGenericArguments.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Echo(list)[0]!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains(
            "Echo[List[managed[int32]?]](list)[0]!!.Borrow()",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayNestedGenericArgumentsPreserveNil()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayNestedGenericNil;
            public class Probe {
                private static T Echo<T>(T value) => value;

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var list = new List<ManagedRef<int>> { source[0] };
                    return Echo(list)[0] == null
                        && Echo<List<ManagedRef<int>>>(list)[0] == null
                            ? 42
                            : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedGenericNil.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("Echo(list)[0]!!", text, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "Echo[List[managed[int32]?]](list)[0]!!",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectedRefExtensionReceiverMatchesStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedRefExtension;
            public struct Slot<T> {
                public T Value;
                public Slot(T value) { Value = value; }
            }
            public static class Extensions {
                public static void CopyFirst<T>(this ref Slot<T> slot, T[] items) {
                    slot.Value = items[0];
                }
            }
            public class Probe {
                private static Slot<T> Make<T>(T[] items) => new Slot<T>(items[0]);

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var slot = Make(source);
                    slot.CopyFirst(source);
                    return slot.Value == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedRefExtension.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        Assert.Contains("var slot", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ZeroArgumentRefExtensionReceiverIsMutable()
    {
        const string source = """
            namespace ZeroArgumentRefExtension;
            public readonly struct Counter {
                public int Value { get; }
                public Counter(int value) { Value = value; }
            }
            public static class Extensions {
                public static void Touch(this ref Counter counter) { }
            }
            public class Probe {
                public static int Run() {
                    var counter = new Counter(42);
                    counter.Touch();
                    return counter.Value;
                }
            }
            """;
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ZeroArgumentRefExtension.cs", source) },
            CSharpProjectLoader.RuntimeReferences());
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        Assert.Contains("var counter", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayElementRejectsNonNullableRefExtensionReceiver()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayNonNullableRefExtension;
            public struct Slot<T> {
                public T Value;
                public Slot(T value) { Value = value; }
            }
            public static class Extensions {
                public static void Touch(this ref Slot<ManagedRef<int>> value) { }
            }
            public class Probe {
                private static Slot<T> Make<T>(T[] items) => new Slot<T>(items[0]);

                public static void Run() {
                    var source = new ManagedRef<int>[1];
                    var slot = Make(source);
                    slot.Touch();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNonNullableRefExtension.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("by-reference storage", StringComparison.Ordinal));
    }

    [Fact]
    public void ManagedReferenceArrayProjectedInExtensionReceiverMatchesStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedInExtension;
            public readonly struct Slot<T> {
                public T Value { get; }
                public Slot(T value) { Value = value; }
            }
            public static class Extensions {
                public static bool BothNil<T>(this in Slot<T> slot, T[] items) =>
                    slot.Value is null && items[0] is null;
            }
            public class Probe {
                private static Slot<T> Make<T>(T[] items) => new Slot<T>(items[0]);

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var slot = Make(source);
                    return slot.BothNil(source) ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedInExtension.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        Assert.DoesNotContain("slot!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectedSequenceTracksForEachBinding()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayProjectedSequence;
            public class Probe {
                private static IEnumerable<T> AsEnumerable<T>(T[] items) => items;

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    foreach (var item in AsEnumerable(source)) {
                        return item.Borrow();
                    }
                    return 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedSequence.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ProjectedGenericSequenceUsesItsEnumerableElementContract()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayProjectedEnumerableContract;
            public sealed class Numbers<T> : IEnumerable<int> {
                public IEnumerator<int> GetEnumerator() {
                    yield return 3;
                }
                IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
            }
            public class Probe {
                private static Numbers<T> Wrap<T>(T[] items) => new();

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    foreach (var item in Wrap(source)) {
                        return item.ToString().Length + 41;
                    }
                    return 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedEnumerableContract.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("item!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectedAsyncSequenceTracksForEachBinding()
    {
        const string source = """
            using System.Collections.Generic;
            using System.Threading.Tasks;
            using Gsharp.Values;
            namespace ManagedArrayProjectedAsyncSequence;
            public class Probe {
                private static async IAsyncEnumerable<T> AsAsync<T>(T[] items) {
                    await Task.Yield();
                    foreach (var item in items) {
                        yield return item;
                    }
                }

                public static async Task<int> Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    await foreach (var item in AsAsync(source)) {
                        return item.Borrow();
                    }
                    return 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedAsyncSequence.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("await for item in AsAsync(source)", text, StringComparison.Ordinal);
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run().GetAwaiter().GetResult()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ProjectedDualEnumerableUsesTheSelectedForEachContract()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using System.Threading;
            using System.Threading.Tasks;
            using Gsharp.Values;
            namespace ManagedArrayProjectedDualSequence;
            public sealed class Dual<T> : IEnumerable<int>, IAsyncEnumerable<T> {
                private readonly T[] items;
                public Dual(T[] items) { this.items = items; }

                public IEnumerator<int> GetEnumerator() {
                    yield return 39;
                }
                IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

                public async IAsyncEnumerator<T> GetAsyncEnumerator(
                    CancellationToken cancellationToken = default) {
                    await Task.Yield();
                    yield return items[0];
                }
            }
            public class Probe {
                private static Dual<T> Wrap<T>(T[] items) => new Dual<T>(items);

                public static async Task<int> Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    int total = 0;
                    foreach (var number in Wrap(source)) {
                        total += number;
                    }
                    await foreach (var item in Wrap(source)) {
                        total += item.Borrow();
                    }
                    return total;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedDualSequence.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("for number in Wrap(source)", text, StringComparison.Ordinal);
        Assert.Contains("await for item in Wrap(source)", text, StringComparison.Ordinal);
        Assert.DoesNotContain("number!!", text, StringComparison.Ordinal);
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionFlowsThroughIndexers()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedIndexer;
            public class Box<T> {
                private readonly T[] items;
                public Box(T[] items) { this.items = items; }
                public T this[int index] => this.items[index];
            }
            public class Probe {
                private static Box<T> Wrap<T>(T[] items) => new Box<T>(items);

                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return Wrap(source)[0].Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedIndexer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Wrap(source)[0]!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayConstrainedGenericFailsLoudly()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayConstrainedGeneric;
            public class Probe {
                private static T First<T>(T[] items) where T : class => items[0];

                public static ManagedRef<int> Run() {
                    var source = new ManagedRef<int>[1];
                    return First<ManagedRef<int>>(source);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayConstrainedGeneric.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("constraint", StringComparison.Ordinal));
        Assert.DoesNotContain("First[managed[int32]?]", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ManagedReferenceArrayAsGenericValueKeepsNonNullOuterArray()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayGenericValue;
            public class Probe {
                private static T Identity<T>(T value) where T : class => value;

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var result = Identity<ManagedRef<int>[]>(source);
                    return result[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayGenericValue.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Identity[[]managed[int32]?](source)", text, StringComparison.Ordinal);
        Assert.DoesNotContain("Identity[[]managed[int32]??]", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectsContainingGenericType()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayContainingType;
            public class Holder<T> {
                private readonly T value;
                public Holder(T[] items) { this.value = items[0]; }
                public T Get() => this.value;
                public T Read(T[] items) => items[0];
            }
            public class Probe {
                public static int Run() {
                    int[] values = { 3 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var holder = new Holder<ManagedRef<int>>(source);
                    return holder.Get().Borrow() + holder.Read(source).Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayContainingType.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Holder[managed[int32]?](source)", text, StringComparison.Ordinal);
        Assert.Contains("holder.Get()!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("holder.Read(source)!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayNAryCollectionInitializerUsesProjectedAdd()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayNAryCollectionInitializer;
            public sealed class Rows<T> : IEnumerable {
                private readonly List<T> values = new();
                public T First => this.values[0];
                public void Add(int key, T value, bool keep) {
                    if (keep) {
                        this.values.Add(value);
                    }
                }
                IEnumerator IEnumerable.GetEnumerator() => this.values.GetEnumerator();
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var rows = new Rows<ManagedRef<int>> {
                        { 0, source[0], true },
                    };
                    return rows.First == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNAryCollectionInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Rows[managed[int32]?]()", text, StringComparison.Ordinal);
        Assert.Contains("values.Add(0, source[0], true)", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayParamsCollectionInitializerUsesEveryExpandedArgument()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayParamsCollectionInitializer;
            public sealed class Rows<T> : IEnumerable {
                private readonly List<T> values = new();
                public T Last => this.values[this.values.Count - 1];
                public void Add(int key, params T[] added) {
                    foreach (var value in added) {
                        this.values.Add(value);
                    }
                }
                public IEnumerator GetEnumerator() => this.values.GetEnumerator();
            }
            public class Probe {
                public static int Run() {
                    int[] values = { 7 };
                    var source = new ManagedRef<int>[1];
                    var nonNull = ManagedRef<int>.FromArray(values, 0);
                    var rows = new Rows<ManagedRef<int>> { { 0, nonNull, source[0] } };
                    return rows.Last == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayParamsCollectionInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Rows[managed[int32]?]()", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayParamsEnumerableInitializerProjectsElementContract()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayParamsEnumerableInitializer;
            public sealed class Rows<T> : IEnumerable {
                private readonly List<T> values = new();
                public T Last => this.values[this.values.Count - 1];
                public void Add(int key, params IEnumerable<T> added) {
                    foreach (var value in added) {
                        this.values.Add(value);
                    }
                }
                public IEnumerator GetEnumerator() => this.values.GetEnumerator();
            }
            public class Probe {
                public static int Run() {
                    int[] values = { 7 };
                    var source = new ManagedRef<int>[1];
                    var nonNull = ManagedRef<int>.FromArray(values, 0);
                    var rows = new Rows<ManagedRef<int>> { { 0, nonNull, source[0] } };
                    return rows.Last == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayParamsEnumerableInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Rows[managed[int32]?]()", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayParamsEnumerableInitializerKeepsNormalFormCollection()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayParamsEnumerableInitializerNormalForm;
            public sealed class Rows<T> : IEnumerable {
                private readonly List<T> values = new();
                public T First => this.values[0];
                public void Add(int key, params IEnumerable<T> added) {
                    foreach (var value in added) {
                        this.values.Add(value);
                    }
                }
                public IEnumerator GetEnumerator() => this.values.GetEnumerator();
            }
            public class Probe {
                public static int Run() {
                    var rows = new Rows<ManagedRef<int>> {
                        { 0, new ManagedRef<int>[1] },
                    };
                    return rows.First == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayParamsEnumerableInitializerNormalForm.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Rows[managed[int32]?]{", text, StringComparison.Ordinal);
        Assert.DoesNotContain("!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayParamsEnumerableInitializerRejectsNullCollectionForm()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayParamsEnumerableInitializerNullForm;
            public sealed class Rows<T> : IEnumerable {
                public bool SawNull { get; private set; }
                public void Add(int key, params IEnumerable<T> added) {
                    if (key == 1) {
                        this.SawNull = added == null;
                    }
                }
                public IEnumerator GetEnumerator() => System.Array.Empty<T>().GetEnumerator();
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var rows = new Rows<ManagedRef<int>> {
                        { 0, source[0] },
                        { 1, null },
                    };
                    return rows.SawNull ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayParamsEnumerableInitializerNullForm.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "direct null/default params carrier",
                    StringComparison.Ordinal));
        Assert.True(
            text.Contains("Rows[managed[int32]?]", StringComparison.Ordinal),
            text);
    }

    [Theory]
    [InlineData("T[]", "null")]
    [InlineData("T[]", "default")]
    [InlineData("T[]", "default(ManagedRef<int>[])")]
    [InlineData("IEnumerable<T>", "default")]
    [InlineData(
        "IEnumerable<T>",
        "default(IEnumerable<ManagedRef<int>>)")]
    public void ManagedReferenceArrayParamsInitializerRejectsNullOrDefaultCarrier(
        string carrierType,
        string carrier)
    {
        var source = $$"""
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayParamsInitializerNullOrDefaultCarrier;
            public sealed class Rows<T> : IEnumerable {
                public void Add(int key, params {{carrierType}} added) { }
                public IEnumerator GetEnumerator() => System.Array.Empty<T>().GetEnumerator();
            }
            public class Probe {
                public static void Run() {
                    var rows = new Rows<ManagedRef<int>> {
                        { 1, {{carrier}} },
                    };
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayParamsInitializerNullOrDefaultCarrier.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "direct null/default params carrier",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void NestedManagedReferenceArrayParamsInitializerRejectsNullCarrier()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayNestedParamsInitializerNullCarrier;
            public sealed class Rows<T> : IEnumerable {
                public void Add(int key, params T[] added) { }
                public IEnumerator GetEnumerator() => System.Array.Empty<T>().GetEnumerator();
            }
            public sealed class Holder<T> {
                public Rows<T> Rows { get; } = new Rows<T>();
            }
            public class Probe {
                public static void Run() {
                    var holder = new Holder<ManagedRef<int>> {
                        Rows = {
                            { 1, null },
                        },
                    };
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedParamsInitializerNullCarrier.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "direct null/default params carrier",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ManagedReferenceArrayParamsCollectionInitializerKeepsNormalFormArray()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayParamsCollectionInitializerNormalForm;
            public sealed class Rows<T> : IEnumerable {
                private readonly List<T> values = new();
                public T Last => this.values[this.values.Count - 1];
                public void Add(params T[] added) {
                    foreach (var value in added) {
                        this.values.Add(value);
                    }
                }
                public IEnumerator GetEnumerator() => this.values.GetEnumerator();
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var rows = new Rows<ManagedRef<int>> { source };
                    return rows.Last == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayParamsCollectionInitializerNormalForm.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "Rows[managed[int32]?]{ source }",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain("Rows[[]managed[int32]?]", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Theory]
    [InlineData("holder.Field = source[0];", "holder.Field")]
    [InlineData("holder.Property = source[0];", "holder.Property")]
    [InlineData("holder[0] = source[0];", "holder[0]")]
    public void ManagedReferenceArrayProjectionIncludesLaterMemberWrites(
        string assignment,
        string read)
    {
        var source = $$"""
            using Gsharp.Values;
            namespace ManagedArrayLaterMemberWrite;
            public sealed class Holder<T> {
                public T Field;
                public T Property { get; set; }
                public T this[int index] {
                    get => this.Field;
                    set => this.Field = value;
                }
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<ManagedRef<int>>();
                    {{assignment}}
                    return {{read}} == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayLaterMemberWrite.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Holder[managed[int32]?]()", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NonManagedByRefArrayElementDoesNotTriggerProjectionValidation()
    {
        const string source = """
            namespace NonManagedByRefArrayElement;
            public class Probe {
                private static bool Find(out string failure) {
                    failure = null;
                    return false;
                }

                public static int Run() {
                    var failures = new string[1];
                    Find(out failures[0]);
                    return failures[0] == null ? 42 : 0;
                }
            }
            """;
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("NonManagedByRefArrayElement.cs", source) },
            CSharpProjectLoader.RuntimeReferences());
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionIncludesNestedLaterMemberWrites()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayNestedLaterMemberWrite;
            public sealed class Holder<T> {
                public T Field;
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var values = new List<ManagedRef<int>> { source[0] };
                    var holder = new Holder<List<ManagedRef<int>>>();
                    holder.Field = values;
                    return holder.Field[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedLaterMemberWrite.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "Holder[List[managed[int32]?]]()",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionIncludesNestedCollectionLaterMemberWrite()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayNestedCollectionLaterMemberWrite;
            public sealed class Holder<T> {
                public T Value;
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<List<ManagedRef<int>>>();
                    holder.Value = new List<ManagedRef<int>> { source[0] };
                    return holder.Value[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedCollectionLaterMemberWrite.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "Holder[List[managed[int32]?]]()",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionFlowsThroughTupleInference()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayTupleInference;
            public class Probe {
                private static int Check<T>((int Tag, T Value) value) =>
                    value.Value == null ? 42 : 0;
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return Check((Tag: 0, Value: source[0]));
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayTupleInference.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "Check((Tag: 0, Value: source[0]))",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionRejectsConflictingArgumentEvidence()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayConflictingEvidence;
            public class Probe {
                private static bool Same<T>(T first, T second) => true;

                public static bool Run() {
                    var source = new ManagedRef<int>[1];
                    var nullableList = new List<ManagedRef<int>> { source[0] };
                    var fixedList = new List<ManagedRef<int>>();
                    return Same(nullableList, fixedList);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayConflictingEvidence.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "conflicting argument types",
                    StringComparison.Ordinal));
        Assert.DoesNotContain(
            "Same[List[managed[int32]?]](nullableList, fixedList)",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ProjectedMethodResultDoesNotChangeFixedExpressionLambdaReturn()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayFixedExpressionLambdaReturn;
            public sealed class Holder<T> {
                public Holder(T value) { }
            }
            public class Probe {
                private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
                private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
                private static readonly Func<Holder<ManagedRef<int>>> Factory =
                    () => Wrap(Source);
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedExpressionLambdaReturn.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "fixed destination storage",
                    StringComparison.Ordinal));
        Assert.DoesNotContain(
            "Wrap[managed[int32]?](Source)",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ProjectedMethodResultCanDefineNaturalExpressionLambdaReturn()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayNaturalExpressionLambdaReturn;
            public sealed class Holder<T> {
                public T Value { get; }
                public Holder(T value) { Value = value; }
            }
            public class Probe {
                private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
                private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);

                public static int Run() {
                    var factory = () => Wrap(Source);
                    return factory().Value == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNaturalExpressionLambdaReturn.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Wrap(Source)", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ProjectedMethodResultCanDefineInferredGenericLambdaReturn()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayInferredGenericLambdaReturn;
            public sealed class Holder<T> {
                public T Value { get; }
                public Holder(T value) { Value = value; }
            }
            public class Probe {
                private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
                private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
                private static TResult Apply<T, TResult>(
                    T value,
                    Func<T, TResult> selector) =>
                    selector(value);

                public static int Run() {
                    var holder = Apply(0, _ => Wrap(Source));
                    return holder.Value == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayInferredGenericLambdaReturn.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Wrap(Source)", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionFlowsThroughCallbackReturn()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayCallbackReturn;
            public class Probe {
                private static T Create<T>(Func<T> factory) => factory();

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var expression = Create<ManagedRef<int>>(() => source[0]);
                    var block = Create<ManagedRef<int>>(() => {
                        return source[0];
                    });
                    return expression == null && block == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayCallbackReturn.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Equal(
            2,
            text.Split("Create[managed[int32]?]", StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionRejectsFixedLambdaResultStorage()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayFixedLambdaResult;
            public class Probe {
                private static ManagedRef<int> Create(Func<ManagedRef<int>> factory) =>
                    factory();

                public static ManagedRef<int> Run() {
                    var source = new ManagedRef<int>[1];
                    return Create(() => source[0]);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedLambdaResult.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "callback return storage",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void InferredDelegateInvocationKeepsProjectedLambdaReturn()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayInferredDelegateReturn;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var get = () => source[0];
                    return get().Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayInferredDelegateReturn.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("get()!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ContainingTypeProjectionIncludesGenericOuterType()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayNestedContainingType;
            public class Outer<T> {
                public class Inner {
                    private readonly T value;
                    public Inner(T[] items) { this.value = items[0]; }
                    public T Get() => this.value;
                }
            }
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var inner = new Outer<ManagedRef<int>>.Inner(source);
                    return inner.Get().Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedContainingType.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("let inner = Inner(source)", text, StringComparison.Ordinal);
        Assert.Contains("inner.Get()!!.Borrow()", text, StringComparison.Ordinal);
    }

    [Fact]
    public void FailedOuterProjectionInvalidatesNestedCallProjection()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayFailedOuterProjection;
            public sealed class Holder<T> {
                public bool Accept(T value) => true;
            }
            public class Probe {
                private static readonly Holder<ManagedRef<int>> Fixed = new();
                private static T First<T>(T[] items) => items[0];

                public static bool Run() {
                    var source = new ManagedRef<int>[1];
                    return Fixed.Accept(First(source));
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFailedOuterProjection.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "fixed receiver storage",
                    StringComparison.Ordinal));
        Assert.DoesNotContain("First[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.Contains("First(source)", text, StringComparison.Ordinal);
    }

    [Fact]
    public void CapturedWriteConstrainsInferredProjectedLocalStorage()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayCapturedLocalWrite;
            public sealed class Holder<T> {
                public Holder(T value) { }
            }
            public class Probe {
                public static bool Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    var fixedValue = ManagedRef<int>.FromArray(values, 0);
                    var holder = new Holder<ManagedRef<int>>(source[0]);
                    Action reset = () => holder = new Holder<ManagedRef<int>>(fixedValue);
                    reset();
                    return holder != null;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayCapturedLocalWrite.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "fixed destination storage",
                    StringComparison.Ordinal));
        Assert.DoesNotContain(
            "Holder[managed[int32]?](source[0])",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionRejectsFixedMethodGroup()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayFixedMethodGroup;
            public class Probe {
                private static bool Apply<T>(T[] items, Func<T, bool> predicate) =>
                    predicate(items[0]);
                private static bool Check(ManagedRef<int> item) => item == null;

                public static bool Run() {
                    var source = new ManagedRef<int>[1];
                    return Apply(source, Check);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedMethodGroup.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "conflicting argument types",
                    StringComparison.Ordinal));
        Assert.DoesNotContain(
            "Apply[managed[int32]?](source, Check)",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void NestedProjectionDoesNotEscapeFailedReceiverProjection()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayFailedReceiverProjection;
            public sealed class Holder<T> {
                public T Value;
                public T Other;
                public bool Same(T other) => true;
            }
            public class Probe {
                private static readonly List<ManagedRef<int>> FixedList = new();

                public static bool Run() {
                    var source = new ManagedRef<int>[1];
                    var holder = (new Holder<List<ManagedRef<int>>>());
                    holder.Value = (new List<ManagedRef<int>> { source[0] });
                    holder.Other = (new List<ManagedRef<int>> { source[0] });
                    holder.Value = FixedList;
                    return holder.Same(FixedList);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFailedReceiverProjection.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        Assert.DoesNotContain(
            "List[managed[int32]?]{ source[0] }",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void FixedReceiverFailureDoesNotRetainMethodProjection()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayFailedReceiverMethodProjection;
            public sealed class Holder<T> {
                public bool Same<U>(T first, U second) => true;
            }
            public class Probe {
                private static readonly Holder<ManagedRef<int>> Fixed = new();

                public static bool Run() {
                    var source = new ManagedRef<int>[1];
                    return Fixed.Same<ManagedRef<int>>(source[0], source[0]);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFailedReceiverMethodProjection.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed receiver storage", StringComparison.Ordinal));
        Assert.Contains(
            "Fixed.Same[managed[int32]](source[0]!!, source[0]!!)",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "Fixed.Same[managed[int32]?]",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void FixedReceiverProjectionReportsStorageBeforeArgumentConflict()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayFixedReceiverConflict;
            public sealed class Holder<T> {
                public bool Same(T first, T second) => true;
            }
            public class Probe {
                private static readonly Holder<List<ManagedRef<int>>> Fixed = new();

                public static bool Run() {
                    var source = new ManagedRef<int>[1];
                    var nullableList = new List<ManagedRef<int>> { source[0] };
                    var fixedList = new List<ManagedRef<int>>();
                    return Fixed.Same(nullableList, fixedList);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedReceiverConflict.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "fixed receiver storage",
                    StringComparison.Ordinal));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Message.Contains(
                "conflicting argument types",
                StringComparison.Ordinal));
    }

    [Fact]
    public void ReducedExtensionDelegateArgumentsUseReducedParameterOrdinals()
    {
        const string source = """
            using System;
            using System.Collections.Generic;
            using System.Linq;
            namespace ReducedExtensionDelegateOrdinals;
            public sealed class Track {
                public long Offset;
                public IEnumerable<int> Items() => new[] { 42 };
            }
            public static class EnumerableExtensions {
                public static IEnumerable<TResult> InterleaveBy<TSource, TResult, TKey>(
                    this IEnumerable<TSource> source,
                    Func<TSource, IEnumerable<TResult>> selector,
                    Func<TResult, TKey> keySelector) =>
                    selector(source.First());
            }
            public class Probe {
                public static int Run() =>
                    new[] { new Track() }
                        .InterleaveBy(t => t.Items(), item => item)
                        .First();
            }
            """;
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ReducedExtensionDelegateOrdinals.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("(t Track) -> t.Items()", text, StringComparison.Ordinal);
        Assert.Contains("(item int32) -> item", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionUpdatesParameterlessAnonymousDelegate()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedAnonymousDelegate;
            public class Probe {
                private static TResult Apply<T, TResult>(
                    T[] items,
                    System.Func<T, TResult> selector) =>
                    selector(items[0]);

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return Apply(source, delegate { return true; }) ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedAnonymousDelegate.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "_ Gsharp.Values.ManagedRef[int32]?",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionAllowsNaturalLambdaDelegateTarget()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayNaturalLambdaDelegate;
            public class Probe {
                private static bool IsNil<T>(T[] items, Delegate callback) =>
                    items[0] is null;

                public static bool Run() {
                    var source = new ManagedRef<int>[1];
                    return IsNil(source, () => 1);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNaturalLambdaDelegate.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionUpdatesLambdaParameterType()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedLambda;
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return source.Select(item => item == null).First() ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedLambda.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "item Gsharp.Values.ManagedRef[int32]?",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void QueryRangeVariableUsesProjectedManagedReferenceArrayElementType()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedQueryRange;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return (from item in source select item.Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedQueryRange.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "item managed[int32]?",
            text,
            StringComparison.Ordinal);
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void AdditionalFromRangeUsesProjectedManagedReferenceArrayElementType()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedAdditionalFromRange;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return (from outer in new[] { 0 }
                            from item in source
                            select item.Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedAdditionalFromRange.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "item managed[int32]?",
            text,
            StringComparison.Ordinal);
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NestedArrayMemberInitializerUsesProjectedElementType()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayNestedArrayInitializer;
            public sealed class Holder<T> {
                public Holder(T value) { }
                public T[] Items { get; } = new T[1];
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var holder = new Holder<ManagedRef<int>>(source[0]) {
                        Items = { [0] = source[0] },
                    };
                    return holder.Items[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedArrayInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Holder[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void RepeatedGenericProjectionConflictReportsUnsupported()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayRepeatedGenericProjection;
            public sealed class Pair<TFirst, TSecond> {
                public TFirst First;
                public TSecond Second;
            }
            public class Probe {
                private static void Accept<T>(Pair<T, T> pair) { }
                public static void Run() {
                    int[] values = { 1 };
                    var source = new ManagedRef<int>[1];
                    var nonNull = ManagedRef<int>.FromArray(values, 0);
                    Accept(new Pair<ManagedRef<int>, ManagedRef<int>> {
                        First = nonNull,
                        Second = source[0],
                    });
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayRepeatedGenericProjection.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "conflicting argument types",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void StaticGenericMemberWriteWithProjectedValueReportsUnsupported()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayStaticGenericMemberWrite;
            public static class Holder<T> {
                public static T Value;
            }
            public class Probe {
                public static void Run() {
                    var source = new ManagedRef<int>[1];
                    Holder<ManagedRef<int>>.Value = source[0];
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayStaticGenericMemberWrite.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "static generic member's fixed receiver type",
                    StringComparison.Ordinal));
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitQueryRangeVariablePreservesIdentityProjectedElementType()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayExplicitProjectedQueryRange;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return (from ManagedRef<int> item in source
                            select item.Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayExplicitProjectedQueryRange.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "item managed[int32]?",
            text,
            StringComparison.Ordinal);
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void TupleArrayQueryPreservesProjectedManagedReferenceLeaves()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedTupleArrayProjectedQueryRange;
            public static class TupleQueries {
                public static TResult[] Select<TSource, TResult>(
                    this TSource[] source,
                    Func<TSource, TResult> selector) =>
                    new[] { selector(source[0]) };

                public static T First<T>(this T[] source) => source[0];
            }
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var source = new (ManagedRef<int> Reference, int Value)[1];
                    source[0] = (ManagedRef<int>.FromArray(values, 0), 1);
                    return (from pair in source
                            select pair.Reference.Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedTupleArrayProjectedQueryRange.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        Assert.Contains("Reference managed[int32]?", text, StringComparison.Ordinal);
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void QueryContinuationPreservesProjectedManagedReferenceResult()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedQueryContinuation;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var refs = new ManagedRef<int>[1];
                    refs[0] = ManagedRef<int>.FromArray(values, 0);
                    return (from x in refs
                            select x into y
                            select y.Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedQueryContinuation.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("y managed[int32]?", text, StringComparison.Ordinal);
        Assert.Contains("y!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GroupJoinIntoPreservesProjectedManagedReferenceElement()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedGroupJoin;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var refs = new ManagedRef<int>[1];
                    refs[0] = ManagedRef<int>.FromArray(values, 0);
                    return (from key in new[] { 0 }
                            join item in refs on key equals 0 into matches
                            select matches.First().Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedGroupJoin.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "matches sequence[managed[int32]?]",
            text,
            StringComparison.Ordinal);
        Assert.Contains("matches.First()!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NullableValueQueryRangeDoesNotUseReferenceAssertion()
    {
        const string source = """
            using System.Linq;
            namespace NullableValueQueryRange;
            public class Probe {
                public static int Run() {
                    int?[] values = { 42 };
                    return (from x in values
                            select x.GetValueOrDefault()).First();
                }
            }
            """;
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("NullableValueQueryRange.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("x!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void QueryLetKeepsProjectedManagedReferenceRangeType()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedQueryLet;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return (from item in source
                            let copy = item
                            select copy.Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedQueryLet.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "((item managed[int32]?, copy managed[int32]?))",
            text,
            StringComparison.Ordinal);
        Assert.Contains("copy!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void QueryOrderByPreservesProjectedTransparentScope()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedQueryOrderBy;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return (from item in source
                            let copy = item
                            orderby copy.Borrow() descending, item.Borrow()
                            select copy.Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedQueryOrderBy.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Equal(
            2,
            text.Split(
                "System.Linq.Enumerable.Cast",
                StringSplitOptions.None).Length - 1);
        Assert.Contains(".OrderByDescending(", text, StringComparison.Ordinal);
        Assert.Contains(".ThenBy(", text, StringComparison.Ordinal);
        Assert.Contains("copy!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ProjectedLambdaParameterTypeFlowsIntoCallArguments()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedLambdaArgument;
            public class Probe {
                private static bool Read(ManagedRef<int> item) => item.Borrow() == 7;

                public static int Run() {
                    int[] values = { 7 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return source.Select(item => Read(item)).First() ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedLambdaArgument.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Read(item!!)", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ExpressionTreeCallbacksUseProjectedManagedReferenceContracts()
    {
        const string source = """
            using System;
            using System.Linq;
            using System.Linq.Expressions;
            using Gsharp.Values;
            namespace ManagedArrayProjectedExpressionTreeCallbacks;
            public class Probe {
                private static T Create<T>(Expression<Func<T>> factory, T fallback) => fallback;
                private static bool Test<T>(T[] source, Expression<Func<T, bool>> predicate) =>
                    source[0] != null;

                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var created = Create<ManagedRef<int>>(() => source.First(), source[0]);
                    return Test(source, item => item != null)
                        && created.Borrow() == 42
                        ? 42
                        : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedExpressionTreeCallbacks.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "item Gsharp.Values.ManagedRef[int32]?",
            text,
            StringComparison.Ordinal);
        Assert.Contains("Create[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.Contains("created!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConditionalAndSwitchArgumentsPreserveManagedReferenceProjection()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedConditionalArguments;
            public class Probe {
                private static int Accept<T>(T value) => value == null ? 21 : 0;

                public static int Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    int conditional =
                        Accept<ManagedRef<int>>(flag ? source[0] : source[0]);
                    int switched = Accept<ManagedRef<int>>(
                        flag switch {
                            true => source[0],
                            false => source[0],
                        });
                    return conditional + switched;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedConditionalArguments.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Accept[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.DoesNotContain("Accept[managed[int32]]", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConditionalAndSwitchLocalsPreserveCommonProjectedType()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedCompositeLocals;
            public sealed class Holder<T> {
                public T Value;
            }
            public class Probe {
                private static Holder<T> Wrap<T>(T[] source) =>
                    new Holder<T> { Value = source[0] };

                public static int Run(bool flag) {
                    int[] values = { 21 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var conditional =
                        flag ? Wrap(source) : Wrap(source);
                    var switched =
                        flag switch {
                            true => Wrap(source),
                            false => Wrap(source),
                        };
                    return conditional.Value.Borrow()
                        + switched.Value.Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedCompositeLocals.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("conditional.Value!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("switched.Value!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConditionalNullArmPreservesProjectedArrayElementType()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedConditionalNull;
            public class Probe {
                private static T[] Project<T>(T[] source) => source;
                private static int Accept<T>(T[]? value) =>
                    value == null ? 42 : value[0] == null ? 21 : 0;

                public static int Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    var local = flag ? Project(source) : null;
                    return Accept(local);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedConditionalNull.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "let local []?managed[int32]?",
            text,
            StringComparison.Ordinal);
        Assert.Contains("return Accept(local)", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(false) + Probe.Run(true)",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(63, result.Value);
    }

    [Fact]
    public void ConditionalLocalsUseConvertibleProjectedCommonBase()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedCompositeBase;
            public class Base<T> {
                public T Value;
            }
            public sealed class Derived<T> : Base<T> {
            }
            public class Probe {
                private static Base<T> WrapBase<T>(T[] source) =>
                    new Base<T> { Value = source[0] };
                private static Derived<T> WrapDerived<T>(T[] source) =>
                    new Derived<T> { Value = source[0] };

                public static int Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    var value = flag
                        ? WrapDerived(source)
                        : WrapBase(source);
                    return value.Value == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedCompositeBase.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("value.Value!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConditionalRejectsIncompatibleInvariantProjectedArms()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedInvariantConditional;
            public sealed class Holder<T> {
                public T Value;
            }
            public class Probe {
                private static Holder<T> Wrap<T>(T[] source) =>
                    new Holder<T> { Value = source[0] };

                public static void Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    var fixedValue = new Holder<ManagedRef<int>>();
                    var value = flag ? Wrap(source) : fixedValue;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedInvariantConditional.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "incompatible managed-reference projections",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ConditionalRejectsCovariantProjectedArgumentErasure()
    {
        const string source = """
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayProjectedCovariantConditional;
            public class Probe {
                private static List<T> Wrap<T>(T[] source) =>
                    new List<T> { source[0] };

                public static IEnumerable<object> Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    var selected = flag
                        ? Wrap(source)
                        : (IEnumerable<object>)new List<object>();
                    return selected;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedCovariantConditional.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "incompatible managed-reference projections",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ConditionalPreservesNestedArrayHierarchyProjection()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedNestedHierarchyConditional;
            public interface IProducer<out T> {
                int Value { get; }
            }
            public sealed class Producer<T> : IProducer<T[][]> {
                public int Value => 42;
            }
            public class Probe {
                private static Producer<T> Wrap<T>(T[] source) =>
                    new Producer<T>();
                private static IProducer<T[][]> WrapInterface<T>(T[] source) =>
                    new Producer<T>();

                public static int Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    var selected = flag
                        ? Wrap(source)
                        : WrapInterface(source);
                    return selected.Value;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedNestedHierarchyConditional.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "cast[IProducer[[][]?managed[int32]?]](Wrap(source))",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConditionalRejectsManagedReferenceIdentityErasureThroughCovariance()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedFixedCovariantArgument;
            public interface IProducer<out T> {
            }
            public sealed class Box<T> : IProducer<ManagedRef<int>> {
            }
            public sealed class ObjectProducer : IProducer<object> {
            }
            public class Probe {
                private static Box<T> Wrap<T>(T[] source) => new Box<T>();

                public static void Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    var selected = flag
                        ? Wrap(source)
                        : (IProducer<object>)new ObjectProducer();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedFixedCovariantArgument.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "incompatible managed-reference projections",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ConditionalAllowsOrdinaryCovariantObjectConversion()
    {
        const string source = """
            using Gsharp.Values;
            namespace OrdinaryProjectedCovariantArgument;
            public interface IProducer<out T> {
                int Value { get; }
            }
            public sealed class Box<T> : IProducer<string> {
                public int Value => 42;
            }
            public sealed class ObjectProducer : IProducer<object> {
                public int Value => 42;
            }
            public class Probe {
                private static Box<T> Wrap<T>(T[] source) => new Box<T>();

                public static int Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    var selected = flag
                        ? Wrap(source)
                        : (IProducer<object>)new ObjectProducer();
                    return selected.Value;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("OrdinaryProjectedCovariantArgument.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConditionalKeepsSafeContravariantCommonType()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedContravariantConditional;
            public interface IConsumer<in T> {
                int Consume(T value);
            }
            public sealed class Consumer<T> : IConsumer<T> {
                public int Consume(T value) => 42;
            }
            public sealed class ObjectConsumer : IConsumer<object> {
                public int Consume(object value) => 42;
            }
            public class Probe {
                private static IConsumer<T> Wrap<T>(T[] source) =>
                    new Consumer<T>();

                public static int Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    IConsumer<object> fallback = new ObjectConsumer();
                    var selected = flag ? Wrap(source) : fallback;
                    var storage = new int[1];
                    return selected.Consume(ManagedRef<int>.FromArray(storage, 0));
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedContravariantConditional.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "cast[IConsumer[managed[int32]]](fallback)",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "cast[IConsumer[managed[int32]?]](fallback)",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(false)",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConditionalAllowsVarianceWithSameProjectedArgument()
    {
        const string source = """
            using System.Collections.Generic;
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedVariantControl;
            public class Probe {
                private static List<T> WrapList<T>(T[] source) =>
                    new List<T> { source[0] };
                private static IEnumerable<T> WrapSequence<T>(T[] source) =>
                    new List<T> { source[0] };

                public static int Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    var selected = flag
                        ? WrapList(source)
                        : WrapSequence(source);
                    return selected.Count() == 1 ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedVariantControl.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ImportedStaticGenericMemberWriteWithProjectedValueReportsUnsupported()
    {
        const string source = """
            using Gsharp.Values;
            using static ManagedArrayImportedStaticGenericMemberWrite.Holder<Gsharp.Values.ManagedRef<int>>;
            namespace ManagedArrayImportedStaticGenericMemberWrite;
            public static class Holder<T> {
                public static T Value;
            }
            public class Probe {
                public static void Run() {
                    var source = new ManagedRef<int>[1];
                    Value = source[0];
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayImportedStaticGenericMemberWrite.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "static generic member's fixed receiver type",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ProjectedConditionalLocalValidatesLaterFixedAssignment()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedConditionalLocalAssignment;
            public sealed class Holder<T> {
                public Holder(T value) { Value = value; }
                public T Value { get; }
            }
            public class Probe {
                private static Holder<T> Wrap<T>(T[] source) =>
                    new Holder<T>(source[0]);
                private static Holder<ManagedRef<int>> Fixed(ManagedRef<int> value) =>
                    new Holder<ManagedRef<int>>(value);

                public static void Run(bool flag) {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    var projected = flag ? Wrap(source) : Wrap(source);
                    projected = Fixed(ManagedRef<int>.FromArray(values, 0));
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedConditionalLocalAssignment.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "conflicts with a later assignment or consumer",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ConditionalAndSwitchAssignmentsToProjectedArrayElementsStayNullable()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedCompositeElementWrites;
            public class Probe {
                public static int Run(bool flag) {
                    var source = new ManagedRef<int>[1];
                    var target = new ManagedRef<int>[2];
                    target[0] = flag ? source[0] : source[0];
                    target[1] = flag switch {
                        true => source[0],
                        false => source[0],
                    };
                    return target[0] == null && target[1] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedCompositeElementWrites.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionUpdatesMethodGroupTarget()
    {
        const string source = """
            #nullable enable
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedMethodGroup;
            public class Probe {
                private static bool IsNil<T>(T item) => item == null;

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return source.Select(IsNil<ManagedRef<int>>).First() ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedMethodGroup.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("managed[int32]?", text, StringComparison.Ordinal);
        Assert.Contains("IsNil[managed[int32]?]", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionUpdatesMethodGroupContainingType()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedMethodGroupContainingType;
            public static class Holder<T> {
                public static bool IsNil(T item) => item == null;
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return source.Select(Holder<ManagedRef<int>>.IsNil).First() ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedMethodGroupContainingType.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        Assert.Contains(
            "Holder[managed[int32]?].IsNil",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionUpdatesOuterMethodGroupContainingType()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedArrayProjectedOuterMethodGroupContainingType;
            public static class Outer<T> {
                public static class Inner {
                    public static bool IsNil(T item) => item == null;
                }
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return source.Select(Outer<ManagedRef<int>>.Inner.IsNil).First()
                        ? 42
                        : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedOuterMethodGroupContainingType.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        Assert.Contains(
            "Outer[managed[int32]?].Inner.IsNil",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionRejectsConflictingMethodGroupParameters()
    {
        const string source = """
            using System;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayConflictingMethodGroupParameters;
            public static class Holder<T> {
                public static bool Match(List<T> projected, List<T> fixedValue) => true;
            }
            public class Probe {
                private static bool Apply<T>(
                    T[] source,
                    Func<List<T>, List<ManagedRef<int>>, bool> callback) =>
                    callback(new List<T>(), new List<ManagedRef<int>>());

                public static bool Run() {
                    var source = new ManagedRef<int>[1];
                    return Apply(source, Holder<ManagedRef<int>>.Match);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayConflictingMethodGroupParameters.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "conflicting types for type parameter",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ManagedReferenceArrayProjectionRejectsArrayCovarianceErasure()
    {
        const string source = """
            #nullable enable
            using Gsharp.Values;
            namespace ManagedArrayCovarianceErasure;
            public class Probe {
                public static object[] Run(bool flag) {
                    var managedRefArray = new ManagedRef<int>[1];
                    var selected = flag
                        ? managedRefArray
                        : new object[1];
                    return selected;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayCovarianceErasure.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "incompatible managed-reference projections",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ManagedReferenceArrayProjectionRejectsInterfaceCovarianceErasure()
    {
        const string source = """
            #nullable enable
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedArrayInterfaceCovarianceErasure;
            public class Probe {
                public static IEnumerable<object> Run(bool flag) {
                    var managedRefArray = new ManagedRef<int>[1];
                    var selected = flag
                        ? managedRefArray
                        : (IEnumerable<object>)new List<object>();
                    return selected;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayInterfaceCovarianceErasure.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains(
                    "incompatible managed-reference projections",
                    StringComparison.Ordinal));
    }

    [Fact]
    public void ZeroArgumentGenericProducerUsesProjectedReturnArrayElement()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayZeroArgumentGenericProducer;
            public sealed class Factory<T> {
                public static T[] Make() => new T[1];
            }
            public class Probe {
                private static T[] Make<T>() => new T[1];

                public static int Run() {
                    var methodProduced = Make<ManagedRef<int>>();
                    var containingProduced = Factory<ManagedRef<int>>.Make();
                    return methodProduced[0] == null
                        && containingProduced[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayZeroArgumentGenericProducer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Make[managed[int32]?]()", text, StringComparison.Ordinal);
        Assert.Contains(
            "Factory[managed[int32]?].Make()",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ExplicitArrayDestinationUsesProjectedGenericReturnElement()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayExplicitGenericProducerDestination;
            public class Probe {
                private static T[] Make<T>() => new T[1];

                public static int Run() {
                    ManagedRef<int>[] values = Make<ManagedRef<int>>();
                    return values[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayExplicitGenericProducerDestination.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Make[managed[int32]?]()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ZeroArgumentGenericProducerUsesProjectedNestedReturnArrayElement()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayZeroArgumentNestedGenericProducer;
            public sealed class Box<T> {
                public Box(T value) { Value = value; }
                public T Value { get; }
            }
            public class Probe {
                private static Box<T[]> Make<T>() => new Box<T[]>(new T[1]);

                public static int Run() {
                    var produced = Make<ManagedRef<int>>();
                    return produced.Value[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayZeroArgumentNestedGenericProducer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Make[managed[int32]?]()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ExplicitNestedGenericArrayDestinationRejectsFixedConsumer()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayExplicitNestedGenericDestination;
            public sealed class Holder<T> {
            }
            public class Probe {
                private static T[] Make<T>() => new T[1];
                private static int Consume(Holder<ManagedRef<int>>[] values) => 42;

                public static int Run() {
                    Holder<ManagedRef<int>>[] values =
                        Make<Holder<ManagedRef<int>>>();
                    return Consume(values);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayExplicitNestedGenericDestination.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain(
            "Make[Holder[managed[int32]?]]()",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitArrayReassignmentUsesEmittedArrayElementProjection()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayExplicitReassignment;
            public class Probe {
                private static T[] Make<T>() => new T[1];

                public static int Run() {
                    ManagedRef<int>[] values;
                    values = Make<ManagedRef<int>>();
                    return values[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayExplicitReassignment.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Make[managed[int32]?]()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NestedGenericExplicitArrayReassignmentRemainsFixedStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayNestedGenericExplicitReassignment;
            public sealed class Holder<T> {
            }
            public class Probe {
                private static T[] Produce<T>() => new T[1];

                public static int Run() {
                    Holder<ManagedRef<int>>[] values;
                    values = Produce<Holder<ManagedRef<int>>>();
                    return 42;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedGenericExplicitReassignment.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain(
            "Produce[Holder[managed[int32]?]]()",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void StaticFieldInitializerUsesEmittedArrayElementProjection()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayStaticFieldInitializer;
            public class Probe {
                private static ManagedRef<int>[] Values =
                    Produce<ManagedRef<int>>();

                private static T[] Produce<T>() => new T[1];

                public static int Run() {
                    return Values[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayStaticFieldInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Produce[managed[int32]?]()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void StaticPropertyInitializerUsesEmittedArrayElementProjection()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayStaticPropertyInitializer;
            public class Probe {
                private static ManagedRef<int>[] Values { get; } =
                    Produce<ManagedRef<int>>();

                private static T[] Produce<T>() => new T[1];

                public static int Run() {
                    return Values[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayStaticPropertyInitializer.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Produce[managed[int32]?]()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ArrayParameterUsesEmittedArrayElementProjection()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayParameterProjection;
            public class Probe {
                private static T[] Produce<T>() => new T[1];
                private static int Consume(ManagedRef<int>[] values) =>
                    values[0] == null ? 42 : 0;

                public static int Run() {
                    return Consume(Produce<ManagedRef<int>>());
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayParameterProjection.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Produce[managed[int32]?]()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void LambdaReturnUsesEmittedArrayElementProjection()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayLambdaReturnProjection;
            public class Probe {
                private static T[] Produce<T>() => new T[1];

                public static int Run() {
                    Func<ManagedRef<int>[]> produce =
                        () => Produce<ManagedRef<int>>();
                    var values = produce();
                    return values[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayLambdaReturnProjection.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Produce[managed[int32]?]()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void CovariantObjectArrayParameterRemainsFixedStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayCovariantObjectParameter;
            public class Probe {
                private static T[] Produce<T>() => new T[1];
                private static int Consume(object[] values) => 42;

                public static int Run() {
                    return Consume(Produce<ManagedRef<int>>());
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayCovariantObjectParameter.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain("Produce[managed[int32]?]()", text, StringComparison.Ordinal);
    }

    [Fact]
    public void NestedGenericFieldReassignmentRemainsFixedStorage()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayNestedGenericFieldReassignment;
            public sealed class Holder<T> {
            }
            public class Probe {
                private static Holder<ManagedRef<int>>[] Values =
                    new Holder<ManagedRef<int>>[0];

                private static T[] Produce<T>() => new T[1];

                public static int Run() {
                    Values = Produce<Holder<ManagedRef<int>>>();
                    return 42;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayNestedGenericFieldReassignment.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain(
            "Produce[Holder[managed[int32]?]]()",
            text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void RecursivePatternDesignationRetainsProjectedGenericType()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayRecursivePatternDesignation;
            public sealed class Holder<T> {
                public Holder(T value) { Value = value; }
                public T Value { get; }
            }
            public class Probe {
                private static Holder<T> Wrap<T>(T[] source) => new Holder<T>(source[0]);

                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var wrapped = Wrap(source);
                    return wrapped is { } captured ? captured.Value.Borrow() : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayRecursivePatternDesignation.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("captured.Value!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ProjectedLambdaResultAllowsImplicitDerivedToBaseConversion()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArrayProjectedLambdaDerivedResult;
            public class Base<T> {
                protected Base(T value) { Value = value; }
                public T Value { get; }
            }
            public sealed class Derived<T> : Base<T> {
                public Derived(T value) : base(value) { }
            }
            public class Probe {
                private static Base<T> Apply<T>(
                    T[] source,
                    Func<T[], Base<T>> factory) =>
                    factory(source);

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var result = Apply(
                        source,
                        items => new Derived<ManagedRef<int>>(items[0]));
                    return result.Value == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedLambdaDerivedResult.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "Derived[managed[int32]?](items[0])",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ProjectedConstructionAllowsExplicitReferenceConversions()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedConstructionConversions;
            public interface IMarker { }
            public class Base { }
            public sealed class Derived<T> : Base, IMarker {
                public Derived(T value) { }
            }
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    Base asBase = new Derived<ManagedRef<int>>(source[0]);
                    IMarker asInterface = new Derived<ManagedRef<int>>(source[0]);
                    object asObject = new Derived<ManagedRef<int>>(source[0]);
                    return asBase != null
                        && asInterface != null
                        && asObject != null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedConstructionConversions.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Equal(
            3,
            text.Split("Derived[managed[int32]?](source[0])").Length - 1);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayProjectionFlowsThroughConstructionArgument()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayProjectedConstructionArgument;
            public sealed class Holder<T> {
                public readonly T Value;
                public Holder(T value) { Value = value; }
            }
            public class Probe {
                private static bool IsNil<T>(Holder<T> holder) => holder.Value is null;

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return IsNil(new Holder<ManagedRef<int>>(source[0])) ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayProjectedConstructionArgument.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "IsNil(Holder[managed[int32]?](source[0]))",
            text,
            StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayConstructionArgumentDoesNotChangeFixedTarget()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayFixedConstructionArgument;
            public sealed class Holder<T> {
                public readonly T Value;
                public Holder(T value) { Value = value; }
            }
            public class Probe {
                private static bool IsNil(Holder<ManagedRef<int>> holder) =>
                    holder.Value is null;

                public static bool Run() {
                    var source = new ManagedRef<int>[1];
                    return IsNil(new Holder<ManagedRef<int>>(source[0]));
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayFixedConstructionArgument.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("fixed destination storage", StringComparison.Ordinal));
        Assert.DoesNotContain("Holder[managed[int32]?]", text, StringComparison.Ordinal);
        Assert.Contains("Holder[managed[int32]](source[0]!!)", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionTreeCallbackUsesProjectedDelegateResult()
    {
        const string source = """
            using System;
            using System.Linq.Expressions;
            using Gsharp.Values;
            namespace ManagedArrayExpressionTreeCallback;
            public class Probe {
                private static bool IsNil<T>(Expression<Func<T>> factory) =>
                    factory.Compile()() is null;

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    return IsNil(() => source[0]) ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayExpressionTreeCallback.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("func () managed[int32]?", text, StringComparison.Ordinal);
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal);
    }

    [Fact]
    public void TupleArrayMemberReadKeepsProjectedNullableLeaf()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedTupleArrayMemberRead;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var pairs = new (ManagedRef<int> Reference, int Value)[1];
                    pairs[0] = (ManagedRef<int>.FromArray(values, 0), 0);
                    return pairs[0].Reference.Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedTupleArrayMemberRead.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(
            "pairs[0].Reference!!.Borrow()",
            text,
            StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void TupleArrayForEachBindingsKeepProjectedNullableLeaves()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedTupleArrayForEach;
            public class Probe {
                private static int ReadPair((ManagedRef<int> Reference, int Value)[] pairs) {
                    foreach (var pair in pairs) {
                        return pair.Reference.Borrow();
                    }
                    return 0;
                }

                private static int ReadDeconstructed((ManagedRef<int> Reference, int Value)[] pairs) {
                    foreach (var (reference, _) in pairs) {
                        return reference.Borrow();
                    }
                    return 0;
                }

                public static int Run() {
                    int[] values = { 21 };
                    var pairs = new (ManagedRef<int> Reference, int Value)[1];
                    pairs[0] = (ManagedRef<int>.FromArray(values, 0), 0);
                    return ReadPair(pairs) + ReadDeconstructed(pairs);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedTupleArrayForEach.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("reference!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void TupleArrayQueryRangeKeepsProjectedNullableLeaf()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedTupleArrayQuery;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var pairs = new (ManagedRef<int> Reference, int Value)[1];
                    pairs[0] = (ManagedRef<int>.FromArray(values, 0), 0);
                    return (from pair in pairs select pair.Reference.Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedTupleArrayQuery.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.True(
            !result.Diagnostics.Any(),
            text + Environment.NewLine + string.Join(Environment.NewLine, result.Diagnostics));
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ProjectedDelegateVariableInvocationUsesInvokeReturnType()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedProjectedDelegateInvocation;
            public class Probe {
                private static Func<T> MakeFactory<T>(T[] source) =>
                    () => source[0];

                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var factory = MakeFactory(source);
                    return factory().Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedProjectedDelegateInvocation.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.True(
            text.Contains("factory()!!.Borrow()", StringComparison.Ordinal),
            text);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GroupContinuationUsesProjectedGroupingElementType()
    {
        const string source = """
            using System.Linq;
            using Gsharp.Values;
            namespace ManagedProjectedGroupContinuation;
            public class Probe {
                public static int Run() {
                    int[] values = { 42 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    return (from item in source
                            group item by 0 into g
                            select g.First().Borrow()).First();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedProjectedGroupContinuation.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("g.First()!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ForEachProjectionPreservesFixedConcreteCurrentType()
    {
        const string source = """
            using System.Collections;
            using System.Collections.Generic;
            using Gsharp.Values;
            namespace ManagedProjectedFixedCurrent;
            public sealed class Sequence<T> : IEnumerable<ManagedRef<int>> {
                public IEnumerator<ManagedRef<int>> GetEnumerator() {
                    int[] values = { 3 };
                    yield return ManagedRef<int>.FromArray(values, 0);
                }
                IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
            }
            public class Probe {
                private static Sequence<T> Create<T>(T[] source) => new Sequence<T>();

                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    foreach (var item in Create(source)) {
                        return item.Borrow();
                    }
                    return 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedProjectedFixedCurrent.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.DoesNotContain("item!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ListPatternsPreserveProjectedArrayElementShape()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayListPattern;
            public class Probe {
                public static int Run() {
                    int[] values = { 21 };
                    var source = new ManagedRef<int>[1];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    var pairs = new (ManagedRef<int> Reference, int Value)[1];
                    pairs[0] = (ManagedRef<int>.FromArray(values, 0), 0);
                    var nestedPairs =
                        new ((ManagedRef<int> Reference, int Value) Pair, int Other)[1];
                    nestedPairs[0] =
                        ((ManagedRef<int>.FromArray(values, 0), 0), 0);
                    int first = source is [var item] ? item.Borrow() : 0;
                    int second = pairs is [var pair] ? pair.Reference.Borrow() : 0;
                    int third = pairs is [{ Reference: var reference }]
                        && reference.Borrow() > 0
                        ? reference.Borrow()
                        : 0;
                    int fourth = nestedPairs is [{ Pair.Reference: var nestedReference }]
                        && nestedReference.Borrow() > 0
                        ? nestedReference.Borrow()
                        : 0;
                    return first + second + third + fourth;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArrayListPattern.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("reference!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("nestedReference!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(84, result.Value);
    }

    [Fact]
    public void ListPatternSlicesPreserveProjectedStorageContracts()
    {
        const string source = """
            using System;
            using Gsharp.Values;
            namespace ManagedArraySlicePattern;
            public class Probe {
                private static Span<T> Create<T>(T[] values) => values;

                public static int Run() {
                    int[] values = { 21, 22 };
                    var source = new ManagedRef<int>[2];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    source[1] = ManagedRef<int>.FromArray(values, 1);
                    int first = source is [.. var rest]
                        && rest[0].Borrow() > 0
                        ? rest[0].Borrow()
                        : 0;
                    var buffer = Create(source);
                    int second = buffer is [_, .. var bufferRest]
                        && bufferRest[0].Borrow() > 0
                        ? bufferRest[0].Borrow()
                        : 0;
                    int third = buffer is [.. [var nestedItem, _]]
                        && nestedItem.Borrow() > 0
                        ? nestedItem.Borrow()
                        : 0;
                    return first + second + third;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedArraySlicePattern.cs", source) },
            references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("rest[0]!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("buffer[1..][0]!!.Borrow()", text, StringComparison.Ordinal);
        Assert.Contains("buffer[..][0]!!.Borrow()", text, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(64, result.Value);
    }

    [Theory]
    [InlineData("int managed = 1;", "managed", 4)]
    [InlineData("int managed() => 2;", "managed()", 5)]
    public void AllSymbolCollisionsQualifyRuntimeSpelling(string declaration, string value, int expected)
    {
        var source = $$"""
            using Gsharp.Values;
            namespace ManagedTranslation;
            public class Probe {
                public static int Run() {
                    {{declaration}}
                    int[] values = { 3 };
                    var p = ManagedRef<int>.FromArray(values, 0);
                    return p.Borrow() + {{value}};
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Managed.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Gsharp.Values.ManagedRef[int32].FromArray", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Theory]
    [InlineData("", "0", "readonly managed[int32].FromArray", 3)]
    [InlineData("int managed = 1;", "managed", "Gsharp.Values.ReadOnlyManagedRef[int32].FromArray", 4)]
    [InlineData("int @readonly = 2;", "@readonly", "Gsharp.Values.ReadOnlyManagedRef[int32].FromArray", 5)]
    [InlineData("int readonlyManaged(int value) => value + 1;", "readonlyManaged(3)", "readonly managed[int32].FromArray", 7)]
    public void ReadonlyStaticReceiverMappingPreservesContextualCollisions(string declaration, string value, string spelling, int expected)
    {
        var source = $$"""
            #nullable enable
            using Gsharp.Values;
            namespace ReadonlyTranslation;
            public class Probe {
                public static ReadOnlyManagedRef<T> Identity<T>(ReadOnlyManagedRef<T> value) => value;
                public static ReadOnlyManagedRef<string?>? Empty() => null;
                public static int Run() {
                    {{declaration}}
                    int[] values = { 3 };
                    var p = Identity(ReadOnlyManagedRef<int>.FromArray(values, 0));
                    return p.Borrow() + {{value}};
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Readonly.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(spelling, text);
        Assert.Contains("readonly managed[T]", text);
        Assert.Contains("readonly managed[string?]?", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Theory]
    [InlineData("managed", "Gsharp.Values.ReadOnlyManagedRef[int32]")]
    [InlineData("readonly", "Gsharp.Values.ReadOnlyManagedRef[int32]")]
    [InlineData("readonlyManaged", "readonly managed[int32]")]
    public void OrdinaryContextualTypeNamesKeepTheirTranslatedIdentity(string name, string handleType)
    {
        var source = $$"""
            using Gsharp.Values;
            namespace OrdinaryTypeTranslation;
            public class @{{name}}<T> { public T Value; }
            public class Probe {
                public static int Run() {
                    var ordinary = new @{{name}}<int> { Value = 4 };
                    var p = ReadOnlyManagedRef<int>.FromArray(new[] { 3 }, 0);
                    return p.Borrow() + ordinary.Value;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Names.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(handleType + ".FromArray", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void StructuredCodeModelRetainsLocationAndPermission(bool readOnly)
    {
        var element = new NamedTypeReference("string") { IsNullable = true };
        var type = new ManagedReferenceTypeReference(element, readOnly) { IsNullable = true };
        Assert.Equal((readOnly ? "readonly " : string.Empty) + "managed[string?]?", GSharpPrinter.RenderTypeReference(type));
        var unit = new CompilationUnit(
            "ManagedModel",
            members: new GNode[]
            {
                new MethodDeclaration(
                    "Run",
                    returnType: new NamedTypeReference("int32"),
                    body: new BlockStatement(new GStatement[]
                    {
                        new LocalDeclarationStatement(BindingKind.Var, "value", initializer: LiteralExpression.Int("3")),
                        new LocalDeclarationStatement(
                            BindingKind.Let, "p", new ManagedReferenceTypeReference(new NamedTypeReference("int32"), readOnly),
                            new ManagedReferenceExpression(new IdentifierExpression("value"), readOnly)),
                        new ExpressionStatement(new AssignmentExpression(new IdentifierExpression("value"), LiteralExpression.Int("7"))),
                        new ReturnStatement(new UnaryExpression("*", new IdentifierExpression("p"))),
                    })),
            });
        var text = GSharpPrinter.Print(unit);
        Assert.Contains((readOnly ? "readonly " : string.Empty) + "managed(value)", text);
        var result = EmittedOracle.Evaluate(text + "\nRun()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NullableManagedReferenceCastUsesIntrinsicSyntax()
    {
        const string source = """
            #nullable enable
            using Gsharp.Values;
            namespace ManagedCastTranslation;
            public class Probe {
                public static ManagedRef<int>? Lift(ManagedRef<int> value) =>
                    (ManagedRef<int>?)value;
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedCast.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("cast[managed[int32]?](value)", text);
        var result = EmittedOracle.Evaluate(text, new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
    }
}
