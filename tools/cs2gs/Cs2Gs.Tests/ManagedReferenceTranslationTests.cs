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
            "__anon0 Gsharp.Values.ManagedRef[int32]?",
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
