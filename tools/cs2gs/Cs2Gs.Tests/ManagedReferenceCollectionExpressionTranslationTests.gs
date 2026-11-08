// <copyright file="ManagedReferenceCollectionExpressionTranslationTests.cs" company="GSharp">
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

class ManagedReferenceCollectionExpressionTranslationTests {
    @Fact
    func ManagedReferenceArrayForEachBindingsRemainNullable() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayForEach.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.True(text.Contains("inferred!!.Borrow()", StringComparison.Ordinal), text)
        Assert.True(text.Contains("explicitItem!!.Borrow()", StringComparison.Ordinal), text)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(14, result.Value)
    }

    @Fact
    func ManagedReferenceArrayForEachBindingDoesNotTaintShadowingParameter() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayForEachShadow.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("item!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ManagedReferenceListForEachBindingStaysNonNullable() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedListForEach.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("item!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ManagedReferenceArrayCollectionInitializerWidensGenericContainer() {
        const source = `using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayCollectionInitializer;
public class Probe {
    public static int Run() {
        var source = new ManagedRef<int>[1];
        var values = new List<ManagedRef<int>> { source[0] };
        return values[0] == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCollectionInitializer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("List[managed[int32]?]", text, StringComparison.Ordinal)
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
    func ManagedReferenceArrayCollectionExpressionWidensGenericContainer() {
        const source = `using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayCollectionExpression;
public class Probe {
    public static int Run() {
        var source = new ManagedRef<int>[1];
        List<ManagedRef<int>> values = [source[0]];
        return values[0] == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCollectionExpression.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("List[managed[int32]?]", text, StringComparison.Ordinal)
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
    func ManagedReferenceArrayCollectionExpressionSpreadWidensGenericContainer() {
        const source = `using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayCollectionExpressionSpread;
public class Probe {
    public static int Run() {
        var source = new ManagedRef<int>[1];
        List<ManagedRef<int>> values = [.. source];
        return values[0] == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCollectionExpressionSpread.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("List[managed[int32]?]", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayCollectionExpressionRejectsFixedReturnStorage() {
        const source = `using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayCollectionExpressionFixedReturn;
public class Probe {
    private static List<ManagedRef<int>> Create(
        ManagedRef<int>[] source) =>
        [source[0]];
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCollectionExpressionFixedReturn.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains(
                "collection expression managed-reference projection",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func ManagedReferenceArrayCollectionExpressionAcceptsMatchingNestedArrayStorage() {
        const source = `using System.Collections;
using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayCollectionExpressionNestedArray;
public sealed class Bag<T> : IEnumerable<T> {
    private readonly List<T> values = new();
    public void Add(T value) => this.values.Add(value);
    public T First => this.values[0];
    public IEnumerator<T> GetEnumerator() => this.values.GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
}
public class Probe {
    private static readonly ManagedRef<int>[] Source =
        new ManagedRef<int>[1];
    private static readonly Bag<ManagedRef<int>[]> Field = [Source];
    private static Bag<ManagedRef<int>[]> Property { get; } = [Source];
    private static Bag<ManagedRef<int>[]> Create() => [Source];

    public static int Run() =>
        Field.First[0] == null
        && Property.First[0] == null
        && Create().First[0] == null
            ? 42
            : 0;
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCollectionExpressionNestedArray.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Bag[[]managed[int32]?]", text, StringComparison.Ordinal)
        Assert.DoesNotContain("Source!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayObjectInitializerWidensGenericContainer() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayObjectInitializer.cs", source)},
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
    func ManagedReferenceArrayForEachBindingsBridgeEveryNonNullUse() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayForEachUses.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Read(item!!)", text, StringComparison.Ordinal)
        Assert.Contains("assigned = item!!", text, StringComparison.Ordinal)
        Assert.Contains("return item!!", text, StringComparison.Ordinal)
        Assert.Contains("(item)!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func ForEachNullabilityTracksOnlyInferredBindings() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayForEachConversions.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("converted!!", text, StringComparison.Ordinal)
        Assert.Contains("managed!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func ForEachTypeNamedVarRespectsElementConversion() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNamedVarForEach.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("item!!.Value", text, StringComparison.Ordinal)
    }

    @Fact
    func ForEachReferenceConversionPreservesProjectedNull() {
        const source = `using System.Linq;
using Gsharp.Values;
namespace ManagedArrayConvertedForEach;
public class Probe {
    public static int Run() {
        var source = new ManagedRef<int>[1];
        int result = 0;
        foreach (object item in source) {
            result += item == null ? 20 : 0;
        }

        result += (from object item in source
                   select item == null ? 22 : 0).Single();
        return result;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayConvertedForEach.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("for item object? in source", text, StringComparison.Ordinal)
        Assert.Contains("(item object?) ->", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.True(
            !result.Diagnostics.Any(),
            text + Environment.NewLine + string.Join(Environment.NewLine, result.Diagnostics)
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ForeachProjectionDoesNotRelaxOrdinaryOrExplicitArrayStorage() {
        const source = `#nullable enable
using Gsharp.Values;
namespace ManagedArrayForeachProjectionBoundaries;
public class Probe {
    public static int Run() {
        string?[] words = { "ok" };
        int result = 0;
        foreach (object word in words) {
            result += word == null ? 0 : word.ToString().Length;
        }

        int[] values = { 40 };
        var source = new ManagedRef<int>[1];
        source[0] = ManagedRef<int>.FromArray(values, 0);
        foreach (var reference in source) {
            var strict = new object[] { reference };
            result += strict[0] == null ? 0 : 40;
        }
        return result;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayForeachProjectionBoundaries.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
        Assert.Contains("for word object? in words", text, StringComparison.Ordinal)
        Assert.Contains("[]object{reference!!}", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullableValueArrayReadsAndForEachBindingsStayNullableValues() {
        const source = `#nullable enable
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
}`
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("NullableValueArrays.cs", source)},
            CSharpProjectLoader.RuntimeReferences()
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("values[0]!!", text, StringComparison.Ordinal)
        Assert.DoesNotContain("item!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(text + "\nProbe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ManagedReferenceArrayExpandedParamsUseSubstitutedElementContract() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayGenericParams.cs", source)},
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
    func ManagedReferenceArrayParamsOnlyCallsUseNullableElementContract() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayParamsOnly.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("FirstNil(source[0])", text, StringComparison.Ordinal)
        Assert.Contains("FirstNil[managed[int32]?](source[0])", text, StringComparison.Ordinal)
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
    func ManagedReferenceArrayReadOnlySpanParamsUsesNullableElementContract() {
        const source = `using System;
using Gsharp.Values;
namespace ManagedArrayReadOnlySpanParams;
public class Probe {
    private static bool FirstNil<T>(params ReadOnlySpan<T> values) =>
        values[0] is null;

    public static int Run() {
        var source = new ManagedRef<int>[1];
        return FirstNil<ManagedRef<int>>(source[0]) ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayReadOnlySpanParams.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("FirstNil[managed[int32]?](source[0])", text, StringComparison.Ordinal)
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
    func ManagedReferenceArrayTargetTypedParamsCarrierIsNotExpanded() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayTargetTypedParams.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("default([]managed[int32]?)", text, StringComparison.Ordinal)
        Assert.DoesNotContain("default(managed[int32]?)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayAsSpanTracksProjectedCurrentType() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayPatternEnumerable.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.True(text.Contains("item!!.Borrow()", StringComparison.Ordinal), text)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ManagedReferenceArrayNestedCollectionInitializerProjectsMemberContract() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedCollectionInitializer.cs", source)},
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
    func ManagedReferenceArrayNestedObjectInitializerProjectsMemberContract() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedObjectInitializer.cs", source)},
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
    func ManagedReferenceArrayProjectedSequenceTracksForEachBinding() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedSequence.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ProjectedGenericSequenceUsesItsEnumerableElementContract() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedEnumerableContract.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("item!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectedAsyncSequenceTracksForEachBinding() {
        const source = `using System.Collections.Generic;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedAsyncSequence.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("await for item in AsAsync(source)", text, StringComparison.Ordinal)
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run().GetAwaiter().GetResult()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ProjectedDualEnumerableUsesTheSelectedForEachContract() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedDualSequence.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("for number in Wrap(source)", text, StringComparison.Ordinal)
        Assert.Contains("await for item in Wrap(source)", text, StringComparison.Ordinal)
        Assert.DoesNotContain("number!!", text, StringComparison.Ordinal)
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal)
    }

    @Fact
    func ManagedReferenceArrayNAryCollectionInitializerUsesProjectedAdd() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNAryCollectionInitializer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Rows[managed[int32]?]()", text, StringComparison.Ordinal)
        Assert.Contains("values.Add(0, source[0], true)", text, StringComparison.Ordinal)
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
    func ManagedReferenceArrayParamsCollectionInitializerUsesEveryExpandedArgument() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayParamsCollectionInitializer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Rows[managed[int32]?]()", text, StringComparison.Ordinal)
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
    func ManagedReferenceArrayParamsEnumerableInitializerProjectsElementContract() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayParamsEnumerableInitializer.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Rows[managed[int32]?]()", text, StringComparison.Ordinal)
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
    func ManagedReferenceArrayParamsEnumerableInitializerKeepsNormalFormCollection() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayParamsEnumerableInitializerNormalForm.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Rows[managed[int32]?]{", text, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayParamsEnumerableInitializerRejectsNullCollectionForm() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayParamsEnumerableInitializerNullForm.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("direct null/default params carrier", StringComparison.Ordinal)
        )
        Assert.True(text.Contains("Rows[managed[int32]?]", StringComparison.Ordinal), text)
    }

    @Theory
    @InlineData("T[]", "null")
    @InlineData("T[]", "default")
    @InlineData("T[]", "default(ManagedRef<int>[])")
    @InlineData("T[]", "(ManagedRef<int>[])null")
    @InlineData("T[]", "(ManagedRef<int>[])default")
    @InlineData("IEnumerable<T>", "default")
    @InlineData("IEnumerable<T>", "default(IEnumerable<ManagedRef<int>>)")
    @InlineData("IEnumerable<T>", "(IEnumerable<ManagedRef<int>>)null")
    func ManagedReferenceArrayParamsInitializerRejectsNullOrDefaultCarrier(carrierType string, carrier string) {
        let source = (`using System.Collections;
using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayParamsInitializerNullOrDefaultCarrier;
public sealed class Rows<T> : IEnumerable {
    public void Add(int key, params ` + "$carrierType" + ` added) { }
    public IEnumerator GetEnumerator() => System.Array.Empty<T>().GetEnumerator();
}
public class Probe {
    public static void Run() {
        var rows = new Rows<ManagedRef<int>> {
            { 1, ` + "$carrier" + ` },
        };
    }
}`)
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayParamsInitializerNullOrDefaultCarrier.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("direct null/default params carrier", StringComparison.Ordinal)
        )
    }

    @Fact
    func NestedManagedReferenceArrayParamsInitializerRejectsNullCarrier() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNestedParamsInitializerNullCarrier.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("direct null/default params carrier", StringComparison.Ordinal)
        )
    }

    @Fact
    func ManagedReferenceArrayParamsCollectionInitializerKeepsNormalFormArray() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayParamsCollectionInitializerNormalForm.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Rows[managed[int32]?]{ source }", text, StringComparison.Ordinal)
        Assert.DoesNotContain("Rows[[]managed[int32]?]", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func TupleArrayForEachBindingsKeepProjectedNullableLeaves() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedTupleArrayForEach.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("reference!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ForEachProjectionPreservesFixedConcreteCurrentType() {
        const source = `using System.Collections;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedProjectedFixedCurrent.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("item!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ConstructibleCollectionSpreadProjectsThroughAddAndSpanElements() {
        const source = `using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using Gsharp.Values;
namespace ManagedArrayConstructibleSpreadProjection;
public sealed class Bag<T> : IEnumerable<T> {
    private readonly List<T> items = new();
    public void Add(T item) => this.items.Add(item);
    public T First => this.items[0];
    public IEnumerator<T> GetEnumerator() => this.items.GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
}
public sealed class TaggedBag<T, TTag> : IEnumerable<TTag> {
    private readonly List<T> items = new();
    public void Add(T item) => this.items.Add(item);
    public T First => this.items[0];
    public bool HasObjectElement => typeof(T) == typeof(object);
    public bool HasObjectTag => typeof(TTag) == typeof(object);
    public IEnumerator<TTag> GetEnumerator() {
        yield break;
    }
    IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
}
[CollectionBuilder(typeof(BucketBuilder), nameof(BucketBuilder.Create))]
public readonly struct Bucket<T> : IEnumerable<T> {
    public readonly T First;
    public Bucket(T first) => this.First = first;
    public void Add(long ignored) { }
    public IEnumerator<T> GetEnumerator() {
        yield return this.First;
    }
    IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
}
public static class BucketBuilder {
    public static Bucket<T> Create<T>(ReadOnlySpan<T> items) => new Bucket<T>(items[0]);
}
public class Probe {
    private static ReadOnlySpan<T> AsSpan<T>(T[] items) => items;

    public static int Run() {
        int[] intValues = { 42 };
        var source = new ManagedRef<int>[1];
        Bag<ManagedRef<int>> fromArray = [.. source];
        var span = AsSpan(source);
        Bag<ManagedRef<int>> fromSpan = [.. span];
        TaggedBag<ManagedRef<int>, object> tagged = [source[0]];
        TaggedBag<object, object> objectBag = [.. source];
        Bucket<int> intBucket = [.. intValues];
        return fromArray.First == null
            && fromSpan.First == null
            && tagged.First == null
            && tagged.HasObjectTag
            && objectBag.First == null
            && objectBag.HasObjectElement
            ? intBucket.First
            : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayConstructibleSpreadProjection.cs", source)},
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
        Assert.True(text.Contains("Bag[managed[int32]?]", StringComparison.Ordinal), text)
        Assert.True(text.Contains("TaggedBag[managed[int32]?, object]", StringComparison.Ordinal), text)
        Assert.True(text.Contains("TaggedBag[object, object]", StringComparison.Ordinal), text)
        Assert.True(text.Contains("BucketBuilder.Create[int32]([]int32{...intValues})", StringComparison.Ordinal), text)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)

        const taggedSpreadSource = `using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using Gsharp.Values;
namespace ManagedArrayConstructibleTaggedSpread;
public sealed class TaggedBag<T, TTag> : IEnumerable<TTag> {
    private readonly List<T> items = new();
    public void Add(T item) => this.items.Add(item);
    public IEnumerator<TTag> GetEnumerator() {
        yield break;
    }
    IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
}
[CollectionBuilder(typeof(BucketBuilder), nameof(BucketBuilder.Create))]
public readonly struct Bucket<T> : IEnumerable<T> {
    public void Add(long ignored) { }
    public IEnumerator<T> GetEnumerator() {
        yield break;
    }
    IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
}
public static class BucketBuilder {
    public static Bucket<T> Create<T>(ReadOnlySpan<T> items) => default;
}
public class Probe {
    public static void Run() {
        var source = new ManagedRef<int>[1];
        TaggedBag<ManagedRef<int>, object> tagged = [.. source];
        Bucket<ManagedRef<int>> refBucket = [.. source];
    }
}`
        let taggedSpreadProject = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayConstructibleTaggedSpread.cs", taggedSpreadSource)},
            references
        )
        Assert.True(
            taggedSpreadProject.BoundWithoutErrors,
            string.Join(Environment.NewLine, taggedSpreadProject.ErrorDiagnostics)
        )
        let taggedSpreadDocument = Assert.Single(taggedSpreadProject.Documents)
        let taggedSpreadContext = TranslationContext(
            taggedSpreadProject.Compilation,
            taggedSpreadDocument.SemanticModel,
            taggedSpreadDocument.FilePath
        )
        let taggedSpreadText = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(taggedSpreadDocument, taggedSpreadContext)
        )
        Assert.DoesNotContain(
            taggedSpreadContext.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
        )
        Assert.True(
            taggedSpreadText.Contains(
                "let tagged TaggedBag[managed[int32]?, object] = TaggedBag[managed[int32]?, object](){ ...source }",
                StringComparison.Ordinal
            ),
            taggedSpreadText
        )
        Assert.True(
            taggedSpreadText.Contains(
                "BucketBuilder.Create[managed[int32]?]([]managed[int32]?{...source})",
                StringComparison.Ordinal
            ),
            taggedSpreadText
        )

        const conflictingAssignmentSource = `using System.Collections;
using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayConstructibleSpreadConflict;
public sealed class Bag<T> : IEnumerable<T> {
    private readonly List<T> items = new();
    public void Add(T item) => this.items.Add(item);
    public IEnumerator<T> GetEnumerator() => this.items.GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
}
public class Probe {
    public static void Run() {
        var source = new ManagedRef<int>[1];
        Bag<ManagedRef<int>> bag = [.. source];
        bag = new Bag<ManagedRef<int>>();
    }
}`
        let conflictProject = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayConstructibleSpreadConflict.cs", conflictingAssignmentSource)},
            references
        )
        Assert.True(
            conflictProject.BoundWithoutErrors,
            string.Join(Environment.NewLine, conflictProject.ErrorDiagnostics)
        )
        let conflictDocument = Assert.Single(conflictProject.Documents)
        let conflictContext = TranslationContext(
            conflictProject.Compilation,
            conflictDocument.SemanticModel,
            conflictDocument.FilePath
        )
        CSharpToGSharpTranslator().TranslateDocument(conflictDocument, conflictContext)
        Assert.Contains(
            conflictContext.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
    }

    @Fact
    func ExtensionGetEnumeratorForEachProjectsManagedReferenceCurrent() {
        const source = `using System.Collections.Generic;
using System.Threading.Tasks;
using Gsharp.Values;
namespace ManagedArrayExtensionForEach;
public sealed class Sequence<T> {
    public readonly T First;
    public Sequence(T[] items) => this.First = items[0];
}
public struct SequenceEnumerator<T> {
    private readonly T item;
    private bool moved;
    public SequenceEnumerator(T item) {
        this.item = item;
        this.moved = false;
    }
    public T Current => this.item;
    public bool MoveNext() {
        if (this.moved) {
            return false;
        }
        this.moved = true;
        return true;
    }
}
public static class SequenceExtensions {
    public static SequenceEnumerator<T> GetEnumerator<T>(this Sequence<T> sequence) =>
        new SequenceEnumerator<T>(sequence.First);

    public static async IAsyncEnumerator<T> GetAsyncEnumerator<T>(this Sequence<T> sequence) {
        await Task.Yield();
        yield return sequence.First;
    }
}
public class Probe {
    private static Sequence<T> Wrap<T>(T[] items) => new Sequence<T>(items);

    public static async Task<int> Run() {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        source[0] = ManagedRef<int>.FromArray(values, 0);
        int total = 0;
        foreach (var item in Wrap(source)) {
            total += item.Borrow();
        }
        await foreach (var asyncItem in Wrap(source)) {
            total += asyncItem.Borrow();
        }
        return total;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayExtensionForEach.cs", source)},
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
        Assert.True(text.Contains("item!!.Borrow()", StringComparison.Ordinal), text)
        Assert.True(text.Contains("asyncItem!!.Borrow()", StringComparison.Ordinal), text)
    }

    shared {
        private func TranslatePlain(source string)(
            Text string,
            Context TranslationContext
        ) -> ManagedReferenceTranslationTests.TranslatePlain(source)
    }
}
