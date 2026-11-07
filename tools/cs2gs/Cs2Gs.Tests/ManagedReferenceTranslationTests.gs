// <copyright file="ManagedReferenceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.Linq
import Xunit

class ManagedReferenceTranslationTests {
    @Fact
    func DefaultInitializedManagedReferenceArraysUseNullableElements() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrays.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("let retained = [2]managed[int32]?", text)
        Assert.Contains("let readOnly = [2]readonly managed[int32]?", text)
        Assert.Contains("retainedAlias[0]!!.Borrow()", text)
        Assert.Contains("readOnly[1]!!.Borrow()", text)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func DefaultInitializedJaggedManagedReferenceArraysWidenEveryEnclosingElement() {
        const source = `using Gsharp.Values;
namespace ManagedJaggedArrayTranslation;
public class Probe {
    public static int Run() {
        var managed = new ManagedRef<int>[1][];
        var ordinary = new int[1][];
        return managed[0] == null && ordinary.Length == 1 ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedJaggedArrays.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("let managed = [1][]?Gsharp.Values.ManagedRef[int32]?", text, StringComparison.Ordinal)
        Assert.Contains("let ordinary = [1][]int32", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func DefaultInitializedManagedReferenceTupleArraysWidenTupleLeaves() {
        const source = `using Gsharp.Values;
namespace ManagedTupleArrayTranslation;
public class Probe {
    public static int Run() {
        var pairs = new (ManagedRef<int> Reference, int Value)[1];
        return pairs[0].Reference == null && pairs[0].Value == 0 ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedTupleArrays.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Reference managed[int32]?", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func DefaultInitializedManagedReferenceAggregateArraysFailLoudly() {
        const source = `using Gsharp.Values;
namespace ManagedAggregateArrayTranslation;
public struct Holder {
    public ManagedRef<int> Reference;
}
public class Probe {
    public static Holder[] Create() => new Holder[1];
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedAggregateArrays.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("managed-reference storage outside a tuple", StringComparison.Ordinal)
        )
    }

    @Fact
    func ManagedReferenceArraysUseNullableElementsAcrossStorageShapes() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayShapes.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("[1]managed[int32]?", text)
        Assert.Contains("func Create() []managed[int32]?", text)
        Assert.Contains("[1, 1]readonly managed[int32]?", text)
        Assert.Contains("items[0]!!.Borrow()", text)
        Assert.Contains("items[0, 0]!!.Borrow()", text)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(14, result.Value)
    }

    @Fact
    func ManagedReferenceArrayInitializersPreserveNilElements() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayInitializers.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullableArrayInitializerPreservesReferenceConversion() {
        const source = `namespace NullableArrayInitializerConversion;
public class Base { }
public class Derived : Base { }
public class Probe {
    private static Derived? Maybe(bool present) => present ? new Derived() : null;
    public static int Run() {
        var items = new Base?[] { Maybe(true), Maybe(false) };
        return items[0] is Derived && items[1] == null ? 42 : 0;
    }
}`
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("NullableArrayInitializerConversion.cs", source)},
            CSharpProjectLoader.RuntimeReferences()
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        let result = EmittedOracle.Evaluate(text + "\nProbe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullableArrayReadsUseMappedElementNullability() {
        const source = `namespace NullableArrayReads;
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
}`
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("NullableArrayReads.cs", source)},
            CSharpProjectLoader.RuntimeReferences()
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("plain[0]!!", text, StringComparison.Ordinal)
        Assert.Contains("(alias)[0]!!.Length", text, StringComparison.Ordinal)
        Assert.Contains("item!!.Length", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(text + "\nProbe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ManagedReferenceArrayElementWidensGenericContainer() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayGenericContainer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Holder[managed[int32]?](source[0])", text, StringComparison.Ordinal)
        Assert.Contains("List[managed[int32]?]()", text, StringComparison.Ordinal)
        Assert.Contains("list.Add(source[0])", text, StringComparison.Ordinal)
        Assert.DoesNotContain("list.Add(source[0]!!)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayElementProjectsStaticGenericTypeReceiver() {
        const source = `using Gsharp.Values;
namespace ManagedArrayStaticGenericReceiver;
public sealed class Holder<T> {
    public static bool IsNil(T value) => value is null;
}
public class Probe {
    public static int Run() {
        var source = new ManagedRef<int>[1];
        return Holder<ManagedRef<int>>.IsNil(source[0]) ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayStaticGenericReceiver.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Holder[managed[int32]?].IsNil(source[0])", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayElementDoesNotProjectFixedGenericStorage() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedGenericStorage.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed receiver storage", StringComparison.Ordinal)
        )
        Assert.Contains("Items.Add(source[0]!!)", text, StringComparison.Ordinal)
        Assert.Contains("items.Add(source[0]!!)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ManagedReferenceArrayNilCannotSilentlyEnterFixedGenericStorage() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedGenericStorageNil.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed receiver storage", StringComparison.Ordinal)
        )
        Assert.Contains("Items.Add(source[0]!!)", text, StringComparison.Ordinal)
        Assert.Contains("items.Add(source[0]!!)", text, StringComparison.Ordinal)
    }

    @Fact
    func MixedTupleConversionPreservesManagedReferenceSibling() {
        const source = `using Gsharp.Values;
namespace ManagedArrayMixedTupleConversion;
public class Probe {
    public static int Run() {
        var source =
            new (ManagedRef<int> Reference, int Number)[1];
        foreach ((object reference, long number) in source) {
            var copy = new[] { reference };
            return copy[0] == null
                && number == 0L
                ? 42
                : 0;
        }
        return 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayMixedTupleConversion.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("[]object?{reference}", text, StringComparison.Ordinal)
        Assert.DoesNotContain("[]object?{reference!!}", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayGenericResultsKeepCSharpTypeArguments() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayGenericResults.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("First(source)!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("First[managed[int32]?](source)!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("Read(First(source)!!)", text, StringComparison.Ordinal)
        Assert.Contains("Read(First[managed[int32]?](source)!!)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func ManagedReferenceArrayGenericExtensionsAndLocalFunctionsUseWidenedArguments() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayGenericCallShapes.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info)
        Assert.Contains("First[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("Recur[managed[int32]?]", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func ManagedReferenceArrayGenericProjectionAndNestedResultsStayNullable() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayGenericNestedResults.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("source.First()!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("Wrap(source).Value!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("Wrap[managed[int32]?](source).Value!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func ProjectedMethodResultDoesNotChangeFixedArrayElementStorage() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedArrayElementResult.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Wrap[managed[int32]?](Source)", text, StringComparison.Ordinal)
    }

    @Fact
    func ProjectedMethodResultDoesNotChangeFixedTupleElementStorage() {
        const source = `using Gsharp.Values;
namespace ManagedArrayFixedTupleElementResult;
public sealed class Holder<T> {
    public Holder(T value) { }
}
public class Probe {
    private static readonly ManagedRef<int>[] Source = new ManagedRef<int>[1];
    private static Holder<T> Wrap<T>(T[] items) => new Holder<T>(items[0]);
    private static readonly (Holder<ManagedRef<int>>, int) Pair =
        (Wrap<ManagedRef<int>>(Source), 0);
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedTupleElementResult.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Wrap[managed[int32]?](Source)", text, StringComparison.Ordinal)
    }

    @Fact
    func ManagedReferenceArrayProjectionFlowsThroughNestedArgumentTypes() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedArguments.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("First(AsEnumerable(source))!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("First[managed[int32]?](AsEnumerable(source))!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ManagedReferenceArrayGenericProjectionFlowsThroughMethodResults() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayGenericMethodResults.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Wrap(source).Get()!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("Wrap[managed[int32]?](source).Get()!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ManagedReferenceArrayGenericArgumentsUseSubstitutedParameters() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayGenericArguments.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info)
        Assert.Contains("Check[managed[int32]?](source, source[0])", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        Assert.DoesNotContain("First(source)!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionAcceptsCompatibleInferredRefStorage() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCompatibleRefStorage.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("CopyFirst[managed[int32]?](source, &value)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionRejectsIncompatibleFixedRefStorage() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedRefStorage.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Equal(
            2,
            context.Diagnostics.Count(
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                    diagnostic.Message!!.Contains("by-reference storage", StringComparison.Ordinal)
            )
        )
        Assert.DoesNotContain("CopyRef[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.DoesNotContain("CopyOut[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("CopyRef[managed[int32]](source, &value)", text, StringComparison.Ordinal)
        Assert.Contains("CopyOut[managed[int32]](source, out output)", text, StringComparison.Ordinal)
    }

    @Fact
    func ManagedReferenceArrayElementRejectsNonNullableRefParameter() {
        const source = `using Gsharp.Values;
namespace ManagedArrayElementRefStorage;
public class Probe {
    private static void Set(ref ManagedRef<int> value) { }

    public static void Run() {
        var source = new ManagedRef<int>[1];
        Set(ref source[0]);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayElementRefStorage.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("by-reference storage", StringComparison.Ordinal)
        )
    }

    @Fact
    func ProjectionEligibilitySkipsOrdinaryCallsButKeepsManagedArrayCalls() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectionEligibility;
public class Probe {
    private static int Twice(int value) => value * 2;
    private static T Identity<T>(T value) => value;
    private static T First<T>(T[] source) => source[0];

    public static int Run() {
        var source = new ManagedRef<int>[1];
        return Twice(21) + Identity(0) + (First(source) is null ? 0 : -42);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectionEligibility.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let invokedMethods = document
            .SyntaxTree
            .GetRoot()
            .DescendantNodes()
            .OfType[InvocationExpressionSyntax]()
            .Select(
            (invocation InvocationExpressionSyntax) -> document
                .SemanticModel
                .GetSymbolInfo(invocation)
                .Symbol as IMethodSymbol
        )
            .Where((method IMethodSymbol) -> method != nil)
            .ToArray()
        let ordinaryMethod = Assert.Single(invokedMethods, (method IMethodSymbol) -> method.Name == "Twice")
        let genericOrdinaryMethod = Assert.Single(invokedMethods, (method IMethodSymbol) -> method.Name == "Identity")
        let managedArrayMethod = Assert.Single(invokedMethods, (method IMethodSymbol) -> method.Name == "First")
        Assert.False(
            CSharpToGSharpTranslator.MethodMayRequireManagedReferenceArrayProjection(
                ordinaryMethod,
                project.Compilation
            )
        )
        Assert.False(
            CSharpToGSharpTranslator.MethodMayRequireManagedReferenceArrayProjection(
                genericOrdinaryMethod,
                project.Compilation
            )
        )
        Assert.True(
            CSharpToGSharpTranslator.MethodMayRequireManagedReferenceArrayProjection(
                managedArrayMethod,
                project.Compilation
            )
        )
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translator = CSharpToGSharpTranslator()
        let text = GSharpPrinter.Print(translator.TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Equal(1, translator.LastManagedReferenceArrayProjectedMethodCacheCount)
        Assert.DoesNotContain("First(source)!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)

        const ineligibleOnlySource = `namespace ManagedArrayProjectionIneligibleOnly;
public class Probe {
    private static int Twice(int value) => value * 2;
    private static T Identity<T>(T value) => value;

    public static int Run() => Twice(21) + Identity(21);
}`
        let ineligibleProject = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectionIneligibleOnly.cs", ineligibleOnlySource)},
            references
        )
        Assert.True(
            ineligibleProject.BoundWithoutErrors,
            string.Join(Environment.NewLine, ineligibleProject.ErrorDiagnostics)
        )
        let ineligibleDoc = Assert.Single(ineligibleProject.Documents)
        let ineligibleContext = TranslationContext(
            ineligibleProject.Compilation,
            ineligibleDoc.SemanticModel,
            ineligibleDoc.FilePath
        )
        let ineligibleTranslator = CSharpToGSharpTranslator()
        let _ = GSharpPrinter.Print(ineligibleTranslator.TranslateDocument(ineligibleDoc, ineligibleContext))
        Assert.Equal(0, ineligibleTranslator.LastManagedReferenceArrayProjectedMethodCacheCount)
        Assert.Equal(0, ineligibleTranslator.LastManagedReferenceArrayProjectedMethodQueryCount)
    }

    @Fact
    func ManagedReferenceArrayNestedGenericArgumentsProjectRecursively() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedGenericArguments.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Echo(list)[0]!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("Echo[List[managed[int32]?]](list)[0]!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ManagedReferenceArrayNestedGenericArgumentsPreserveNil() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedGenericNil.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("Echo(list)[0]!!", text, StringComparison.Ordinal)
        Assert.DoesNotContain("Echo[List[managed[int32]?]](list)[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectedRefExtensionReceiverMatchesStorage() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedRefExtension.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
        )
        Assert.Contains("var slot", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayElementRejectsNonNullableRefExtensionReceiver() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNonNullableRefExtension.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("by-reference storage", StringComparison.Ordinal)
        )
    }

    @Fact
    func ManagedReferenceArrayProjectedInExtensionReceiverMatchesStorage() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedInExtension.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
        )
        Assert.DoesNotContain("slot!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionFlowsThroughIndexers() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedIndexer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Wrap(source)[0]!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ManagedReferenceArrayConstrainedGenericFailsLoudly() {
        const source = `using Gsharp.Values;
namespace ManagedArrayConstrainedGeneric;
public class Probe {
    private static T First<T>(T[] items) where T : class => items[0];

    public static ManagedRef<int> Run() {
        var source = new ManagedRef<int>[1];
        return First<ManagedRef<int>>(source);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayConstrainedGeneric.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("constraint", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("First[managed[int32]?]", text, StringComparison.Ordinal)
    }

    @Fact
    func ManagedReferenceArrayAsGenericValueKeepsNonNullOuterArray() {
        const source = `using Gsharp.Values;
namespace ManagedArrayGenericValue;
public class Probe {
    private static T Identity<T>(T value) where T : class => value;

    public static int Run() {
        var source = new ManagedRef<int>[1];
        var result = Identity<ManagedRef<int>[]>(source);
        return result[0] == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayGenericValue.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Identity[[]managed[int32]?](source)", text, StringComparison.Ordinal)
        Assert.DoesNotContain("Identity[[]managed[int32]??]", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectsContainingGenericType() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayContainingType.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Holder[managed[int32]?](source)", text, StringComparison.Ordinal)
        Assert.Contains("holder.Get()!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("holder.Read(source)!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(6, result.Value)
    }

    @Theory
    @InlineData("holder.Field = source[0];", "holder.Field")
    @InlineData("holder.Property = source[0];", "holder.Property")
    @InlineData("holder[0] = source[0];", "holder[0]")
    func ManagedReferenceArrayProjectionIncludesLaterMemberWrites(assignment string, read string) {
        let source = (`using Gsharp.Values;
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
        ` + "$assignment" + `
        return ` + "$read" + ` == null ? 42 : 0;
    }
}`)
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayLaterMemberWrite.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Holder[managed[int32]?]()", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NonManagedByRefArrayElementDoesNotTriggerProjectionValidation() {
        const source = `namespace NonManagedByRefArrayElement;
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
}`
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("NonManagedByRefArrayElement.cs", source)},
            CSharpProjectLoader.RuntimeReferences()
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        let result = EmittedOracle.Evaluate(text + "\nProbe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionIncludesNestedLaterMemberWrites() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedLaterMemberWrite.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Holder[List[managed[int32]?]]()", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionIncludesNestedCollectionLaterMemberWrite() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedCollectionLaterMemberWrite.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Holder[List[managed[int32]?]]()", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionFlowsThroughTupleInference() {
        const source = `using Gsharp.Values;
namespace ManagedArrayTupleInference;
public class Probe {
    private static int Check<T>((int Tag, T Value) value) =>
        value.Value == null ? 42 : 0;
    public static int Run() {
        var source = new ManagedRef<int>[1];
        return Check((Tag: 0, Value: source[0]));
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayTupleInference.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Check((Tag: 0, Value: source[0]))", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionRejectsConflictingArgumentEvidence() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayConflictingEvidence.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("conflicting argument types", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Same[List[managed[int32]?]](nullableList, fixedList)", text, StringComparison.Ordinal)
    }

    @Fact
    func AdditionalFromRangeUsesProjectedManagedReferenceArrayElementType() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedAdditionalFromRange.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("item managed[int32]?", text, StringComparison.Ordinal)
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NestedArrayMemberInitializerUsesProjectedElementType() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedArrayInitializer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Holder[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConditionalNullArmPreservesProjectedArrayElementType() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedConditionalNull.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("let local []?managed[int32]?", text, StringComparison.Ordinal)
        Assert.Contains("return Accept(local)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(false) + Probe.Run(true)",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(63, result.Value)
    }

    @Fact
    func ConditionalPreservesNestedArrayHierarchyProjection() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedNestedHierarchyConditional.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("cast[IProducer[[][]?managed[int32]?]](Wrap(source))", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionRejectsArrayCovarianceErasure() {
        const source = `#nullable enable
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCovarianceErasure.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("incompatible managed-reference projections", StringComparison.Ordinal)
        )
    }

    @Fact
    func ManagedReferenceArrayProjectionRejectsInterfaceCovarianceErasure() {
        const source = `#nullable enable
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayInterfaceCovarianceErasure.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("incompatible managed-reference projections", StringComparison.Ordinal)
        )
    }

    @Fact
    func ZeroArgumentGenericProducerUsesProjectedReturnArrayElement() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayZeroArgumentGenericProducer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Make[managed[int32]?]()", text, StringComparison.Ordinal)
        Assert.Contains("Factory[managed[int32]?].Make()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ExplicitArrayDestinationUsesProjectedGenericReturnElement() {
        const source = `using Gsharp.Values;
namespace ManagedArrayExplicitGenericProducerDestination;
public class Probe {
    private static T[] Make<T>() => new T[1];

    public static int Run() {
        ManagedRef<int>[] values = Make<ManagedRef<int>>();
        return values[0] == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayExplicitGenericProducerDestination.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Make[managed[int32]?]()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ZeroArgumentGenericProducerUsesProjectedNestedReturnArrayElement() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayZeroArgumentNestedGenericProducer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Make[managed[int32]?]()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ExplicitNestedGenericArrayDestinationRejectsFixedConsumer() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayExplicitNestedGenericDestination.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Make[Holder[managed[int32]?]]()", text, StringComparison.Ordinal)
    }

    @Fact
    func ExplicitArrayReassignmentUsesEmittedArrayElementProjection() {
        const source = `using Gsharp.Values;
namespace ManagedArrayExplicitReassignment;
public class Probe {
    private static T[] Make<T>() => new T[1];

    public static int Run() {
        ManagedRef<int>[] values;
        values = Make<ManagedRef<int>>();
        return values[0] == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayExplicitReassignment.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Make[managed[int32]?]()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NestedGenericExplicitArrayReassignmentRemainsFixedStorage() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedGenericExplicitReassignment.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Produce[Holder[managed[int32]?]]()", text, StringComparison.Ordinal)
    }

    @Fact
    func StaticFieldInitializerUsesEmittedArrayElementProjection() {
        const source = `using Gsharp.Values;
namespace ManagedArrayStaticFieldInitializer;
public class Probe {
    private static ManagedRef<int>[] Values =
        Produce<ManagedRef<int>>();

    private static T[] Produce<T>() => new T[1];

    public static int Run() {
        return Values[0] == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayStaticFieldInitializer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Produce[managed[int32]?]()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func StaticPropertyInitializerUsesEmittedArrayElementProjection() {
        const source = `using Gsharp.Values;
namespace ManagedArrayStaticPropertyInitializer;
public class Probe {
    private static ManagedRef<int>[] Values { get; } =
        Produce<ManagedRef<int>>();

    private static T[] Produce<T>() => new T[1];

    public static int Run() {
        return Values[0] == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayStaticPropertyInitializer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Produce[managed[int32]?]()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ArrayParameterUsesEmittedArrayElementProjection() {
        const source = `using Gsharp.Values;
namespace ManagedArrayParameterProjection;
public class Probe {
    private static T[] Produce<T>() => new T[1];
    private static int Consume(ManagedRef<int>[] values) =>
        values[0] == null ? 42 : 0;

    public static int Run() {
        return Consume(Produce<ManagedRef<int>>());
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayParameterProjection.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Produce[managed[int32]?]()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func CovariantObjectArrayParameterRemainsFixedStorage() {
        const source = `using Gsharp.Values;
namespace ManagedArrayCovariantObjectParameter;
public class Probe {
    private static T[] Produce<T>() => new T[1];
    private static int Consume(object[] values) => 42;

    public static int Run() {
        return Consume(Produce<ManagedRef<int>>());
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCovariantObjectParameter.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Produce[managed[int32]?]()", text, StringComparison.Ordinal)
    }

    @Fact
    func ManagedReferenceArrayProjectionFlowsThroughConstructionArgument() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedConstructionArgument.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("IsNil(Holder[managed[int32]?](source[0]))", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayConstructionArgumentDoesNotChangeFixedTarget() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedConstructionArgument.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("fixed destination storage", StringComparison.Ordinal)
        )
        Assert.DoesNotContain("Holder[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("Holder[managed[int32]](source[0]!!)", text, StringComparison.Ordinal)
    }

    @Fact
    func TupleArrayMemberReadKeepsProjectedNullableLeaf() {
        const source = `using Gsharp.Values;
namespace ManagedTupleArrayMemberRead;
public class Probe {
    public static int Run() {
        int[] values = { 42 };
        var pairs = new (ManagedRef<int> Reference, int Value)[1];
        pairs[0] = (ManagedRef<int>.FromArray(values, 0), 0);
        return pairs[0].Reference.Borrow();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedTupleArrayMemberRead.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("pairs[0].Reference!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullableValueDictionaryIndexerWriteOfLiteralTranslatesWithoutDiagnostic() {
        // Issue #4525: ordinary code with no managed reference must never hit
        // the "no exact G# translation" rejections.
        let (_, context) = TranslatePlain(`#nullable enable
using System.Collections.Generic;
namespace Plain4525A;
public class Probe {
    public static void Run(IDictionary<string, string?> d) {
        d["k"] = "v";
    }
}`)
        Assert.Empty(context.Diagnostics)
    }

    @Fact
    func ProcessStartInfoEnvironmentIndexerWriteTranslatesWithoutDiagnostic() {
        // The Oahu and code-exploder self-migration gaps.
        let (_, context) = TranslatePlain(`#nullable enable
using System.Diagnostics;
namespace Plain4525F;
public class Probe {
    public static void Run(ProcessStartInfo psi) {
        psi.Environment["OAHU_NO_TUI"] = "1";
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
    }
}`)
        Assert.Empty(context.Diagnostics)
    }

    @Fact
    func GenericStorageWriteFromWidenedArrayElementForgivesInsteadOfRejecting() {
        let (text, context) = TranslatePlain(`#nullable enable
namespace Plain4525D;
public sealed class Holder<T> { public T Field = default!; }
public class Probe {
    public static void Run(Holder<string> holder) {
        var widened = new string[2];
        foreach (var s in widened) holder.Field = s;
    }
}`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
        Assert.Single(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId &&
                d.Message!!.StartsWith(
                "kind=constructed-generic-member | target=Holder<string>.Field",
                StringComparison.Ordinal
            )
        )
        Assert.Contains("!!", text, StringComparison.Ordinal)
    }

    @Fact
    func ConditionalOfFreshAndWidenedStringArraysTranslatesWithoutDiagnostic() {
        let (_, context) = TranslatePlain(`#nullable enable
namespace Plain4525E;
public class Probe {
    public static int Run(bool flag) {
        var widened = new string[2];
        var x = flag ? new string[1] : widened;
        return x.Length;
    }
}`)
        Assert.Empty(context.Diagnostics)
    }

    shared {
        internal func TranslatePlain(source string)(Text string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Plain.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            return (text, context)
        }
    }
}
