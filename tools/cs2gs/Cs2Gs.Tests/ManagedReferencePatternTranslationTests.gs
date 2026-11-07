// <copyright file="ManagedReferencePatternTranslationTests.cs" company="GSharp">
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

class ManagedReferencePatternTranslationTests {
    @Fact
    func DeconstructedForEachUsesProjectedManagedReferenceTupleLeaves() {
        const source = `using Gsharp.Values;
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
        Assert.Contains("item.Pair.Reference!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(84, result.Value)
    }

    @Fact
    func DeconstructedForEachConversionsPreserveProjectedTupleNulls() {
        const source = `#nullable enable
using Gsharp.Values;
namespace ManagedArrayConvertedDeconstruction;
public class Probe {
    public static int Run() {
        int result = 0;
        var source = new (ManagedRef<int> Reference, int Value)[1];
        foreach ((object reference, int value) in source) {
            var copy = new[] { reference };
            result += copy[0] == null && value == 0
                ? 20
                : 0;
        }

        var nested =
            new ((ManagedRef<int> Reference, int Value) Pair, int Tail)[1];
        foreach (((object Reference, int Value) Pair, int Tail)
            in nested) {
            var copy = new[] { Pair.Reference };
            result += copy[0] == null
                && Pair.Value == 0
                && Tail == 0
                ? 22
                : 0;
        }
        return result;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayConvertedDeconstruction.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("reference!!", text, StringComparison.Ordinal)
        Assert.DoesNotContain("Pair.Reference!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func PositionalPatternBinderUsesProjectedRecordSlot() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedPositionalPattern;
public sealed record Holder<T>(T Item);
public class Probe {
    private static Holder<T> Wrap<T>(T item) => new Holder<T>(item);

    public static int Run() {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        source[0] = ManagedRef<int>.FromArray(values, 0);
        var holder = Wrap(source[0]);
        if (holder is Holder<ManagedRef<int>>(var item)) {
            return item.Borrow();
        }
        return 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedPositionalPattern.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("var __spill0 Gsharp.Values.ManagedRef[int32]?", text, StringComparison.Ordinal)
        Assert.Contains("__spill0!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SwitchPositionalTupleBindersPreserveProjectedNulls() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedSwitchTuplePatterns;
public class Probe {
    private static int FromExpression(
        (ManagedRef<int> First, ManagedRef<int> Second) pair) =>
        pair switch {
            (var first, var second) =>
                new[] { first }[0] == null
                    && new[] { second }[0] == null
                    ? 20
                    : 0,
        };

    private static int FromStatement(
        (ManagedRef<int> First, ManagedRef<int> Second) pair) {
        switch (pair) {
            case (var first, var second):
                return new[] { first }[0] == null
                    && new[] { second }[0] == null
                    ? 22
                    : 0;
        }
        return 0;
    }

    public static int Run() {
        var pairs =
            new (ManagedRef<int> First, ManagedRef<int> Second)[1];
        return FromExpression(pairs[0])
            + FromStatement(pairs[0]);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedSwitchTuplePatterns.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("first!!", text, StringComparison.Ordinal)
        Assert.DoesNotContain("second!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func LargeTupleDeconstructionUsesLogicalTupleElements() {
        const source = `using Gsharp.Values;
namespace ManagedArrayLargeTupleDeconstruction;
public class Probe {
    public static int Run() {
        int result = 0;
        var eight =
            new (int A, int B, int C, int D, int E, int F, int G,
                ManagedRef<int> Reference)[1];
        foreach (var (a, b, c, d, e, f, g, reference) in eight) {
            result += new[] { reference }[0] == null ? 20 : 0;
        }

        var nine =
            new (int A, int B, int C, int D, int E, int F, int G,
                int H, ManagedRef<int> Reference)[1];
        foreach (var (a, b, c, d, e, f, g, h, reference) in nine) {
            result += new[] { reference }[0] == null ? 22 : 0;
        }

        return result;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayLargeTupleDeconstruction.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("reference!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func QueryRangeVariableUsesProjectedManagedReferenceArrayElementType() {
        const source = `using System.Linq;
using Gsharp.Values;
namespace ManagedArrayProjectedQueryRange;
public class Probe {
    public static int Run() {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        source[0] = ManagedRef<int>.FromArray(values, 0);
        return (from item in source select item.Borrow()).First();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedQueryRange.cs", source)},
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
    func ExplicitQueryRangeVariablePreservesIdentityProjectedElementType() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayExplicitProjectedQueryRange.cs", source)},
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
    func TupleArrayQueryPreservesProjectedManagedReferenceLeaves() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedTupleArrayProjectedQueryRange.cs", source)},
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
        Assert.Contains("Reference managed[int32]?", text, StringComparison.Ordinal)
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func QueryContinuationPreservesProjectedManagedReferenceResult() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedQueryContinuation.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("y managed[int32]?", text, StringComparison.Ordinal)
        Assert.Contains("y!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func GroupJoinIntoPreservesProjectedManagedReferenceElement() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedGroupJoin.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("matches sequence[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("matches.First()!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullableValueQueryRangeDoesNotUseReferenceAssertion() {
        const source = `using System.Linq;
namespace NullableValueQueryRange;
public class Probe {
    public static int Run() {
        int?[] values = { 42 };
        return (from x in values
                select x.GetValueOrDefault()).First();
    }
}`
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("NullableValueQueryRange.cs", source)}
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("x!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(text + "\nProbe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func QueryLetKeepsProjectedManagedReferenceRangeType() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedQueryLet.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("((item managed[int32]?, copy managed[int32]?))", text, StringComparison.Ordinal)
        Assert.Contains("copy!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func QueryOrderByPreservesProjectedTransparentScope() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedQueryOrderBy.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Equal(2, text.Split("System.Linq.Enumerable.Cast", StringSplitOptions.None).Length - 1)
        Assert.Contains(".OrderByDescending(", text, StringComparison.Ordinal)
        Assert.Contains(".ThenBy(", text, StringComparison.Ordinal)
        Assert.Contains("copy!!.Borrow()", text, StringComparison.Ordinal)
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
    func ConditionalAndSwitchArgumentsPreserveManagedReferenceProjection() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedConditionalArguments.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Accept[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.DoesNotContain("Accept[managed[int32]]", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConditionalAndSwitchLocalsPreserveCommonProjectedType() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedCompositeLocals.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("conditional.Value!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("switched.Value!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConditionalAndSwitchAssignmentsToProjectedArrayElementsStayNullable() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedCompositeElementWrites.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run(true)",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func RecursivePatternDesignationRetainsProjectedGenericType() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayRecursivePatternDesignation.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("captured.Value!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SwitchPatternBindersRetainProjectedManagedReferenceType() {
        const source = `using Gsharp.Values;
namespace ManagedArrayProjectedSwitchPatternBinders;
public class Probe {
    private static int FromExpression(ManagedRef<int>[] source) =>
        source[0] switch {
            var expressionItem => expressionItem == null ? 20 : 0,
        };

    private static int FromStatement(ManagedRef<int>[] source) {
        switch (source[0]) {
            case var statementItem:
                return statementItem == null ? 22 : 0;
        }
    }

    public static int Run() {
        var source = new ManagedRef<int>[1];
        return FromExpression(source) + FromStatement(source);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedSwitchPatternBinders.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("expressionItem!!", text, StringComparison.Ordinal)
        Assert.DoesNotContain("statementItem!!", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func TupleArrayQueryRangeKeepsProjectedNullableLeaf() {
        const source = `using System.Linq;
using Gsharp.Values;
namespace ManagedTupleArrayQuery;
public class Probe {
    public static int Run() {
        int[] values = { 42 };
        var pairs = new (ManagedRef<int> Reference, int Value)[1];
        pairs[0] = (ManagedRef<int>.FromArray(values, 0), 0);
        return (from pair in pairs select pair.Reference.Borrow()).First();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedTupleArrayQuery.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal)
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
    func GroupContinuationUsesProjectedGroupingElementType() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedProjectedGroupContinuation.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("g.First()!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ListPatternsPreserveProjectedArrayElementShape() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayListPattern.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("item!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("pair.Reference!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("reference!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("nestedReference!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(84, result.Value)
    }

    @Fact
    func ListPatternSlicesPreserveProjectedStorageContracts() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArraySlicePattern.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("rest[0]!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("__spill0 = buffer[1..]", text, StringComparison.Ordinal)
        Assert.Contains("__spill0[0]!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(64, result.Value)
        Assert.Contains("__spill1 = buffer[..]", text, StringComparison.Ordinal)
        Assert.Contains("__spill2 = __spill1[0]", text, StringComparison.Ordinal)
        Assert.Contains("__spill2!!.Borrow()", text, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("int managed = 1;", "managed", int32(4))
    @InlineData("int managed() => 2;", "managed()", int32(5))
    func AllSymbolCollisionsQualifyRuntimeSpelling(declaration string, value string, expected int32) {
        let source = (`using Gsharp.Values;
namespace ManagedTranslation;
public class Probe {
    public static int Run() {
        ` + "$declaration" + `
        int[] values = { 3 };
        var p = ManagedRef<int>.FromArray(values, 0);
        return p.Borrow() + ` + "$value" + `;
    }
}`)
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Managed.cs", source)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Gsharp.Values.ManagedRef[int32].FromArray", text)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(expected, result.Value)
    }

    @Theory
    @InlineData("", "0", "readonly managed[int32].FromArray", int32(3))
    @InlineData("int managed = 1;", "managed", "Gsharp.Values.ReadOnlyManagedRef[int32].FromArray", int32(4))
    @InlineData("int @readonly = 2;", "@readonly", "Gsharp.Values.ReadOnlyManagedRef[int32].FromArray", int32(5))
    @InlineData(
        "int readonlyManaged(int value) => value + 1;",
        "readonlyManaged(3)",
        "readonly managed[int32].FromArray",
        int32(7)
    )
    func ReadonlyStaticReceiverMappingPreservesContextualCollisions(
        declaration string,
        value string,
        spelling string,
        expected int32
    ) {
        let source = (`#nullable enable
using Gsharp.Values;
namespace ReadonlyTranslation;
public class Probe {
    public static ReadOnlyManagedRef<T> Identity<T>(ReadOnlyManagedRef<T> value) => value;
    public static ReadOnlyManagedRef<string?>? Empty() => null;
    public static int Run() {
        ` + "$declaration" + `
        int[] values = { 3 };
        var p = Identity(ReadOnlyManagedRef<int>.FromArray(values, 0));
        return p.Borrow() + ` + "$value" + `;
    }
}`)
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Readonly.cs", source)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains(spelling, text)
        Assert.Contains("readonly managed[T]", text)
        Assert.Contains("readonly managed[string?]?", text)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(expected, result.Value)
    }

    @Theory
    @InlineData("managed", "Gsharp.Values.ReadOnlyManagedRef[int32]")
    @InlineData("readonly", "Gsharp.Values.ReadOnlyManagedRef[int32]")
    @InlineData("readonlyManaged", "readonly managed[int32]")
    func OrdinaryContextualTypeNamesKeepTheirTranslatedIdentity(name string, handleType string) {
        let source = (`using Gsharp.Values;
namespace OrdinaryTypeTranslation;
public class @` + "$name" + `<T> { public T Value; }
public class Probe {
    public static int Run() {
        var ordinary = new @` + "$name" + `<int> { Value = 4 };
        var p = ReadOnlyManagedRef<int>.FromArray(new[] { 3 }, 0);
        return p.Borrow() + ordinary.Value;
    }
}`)
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Names.cs", source)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains(handleType + ".FromArray", text)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StructuredCodeModelRetainsLocationAndPermission(readOnly bool) {
        let element = NamedTypeReference("string"){IsNullable = true}
        let type = ManagedReferenceTypeReference(element, readOnly){IsNullable = true}
        Assert.Equal(
            (
                if readOnly {
                    "readonly "
                } else {
                    string.Empty
                }
            ) +
                "managed[string?]?",
            GSharpPrinter.RenderTypeReference(type)
        )
        let unit = CompilationUnit(
            "ManagedModel",
            members: []GNode{
                MethodDeclaration(
                    "Run",
                    returnType: NamedTypeReference("int32"),
                    body: BlockStatement(
                        []GStatement{
                            LocalDeclarationStatement(
                                BindingKind.Var,
                                "value",
                                initializer: LiteralExpression.Int("3")
                            ),
                            LocalDeclarationStatement(
                                BindingKind.Let,
                                "p",
                                ManagedReferenceTypeReference(NamedTypeReference("int32"), readOnly),
                                ManagedReferenceExpression(IdentifierExpression("value"), readOnly)
                            ),
                            ExpressionStatement(
                                AssignmentExpression(IdentifierExpression("value"), LiteralExpression.Int("7"))
                            ),
                            ReturnStatement(UnaryExpression("*", IdentifierExpression("p")))
                        }
                    )
                )
            }
        )
        let text = GSharpPrinter.Print(unit)
        Assert.Contains(
            (
                if readOnly {
                    "readonly "
                } else {
                    string.Empty
                }
            ) +
                "managed(value)",
            text
        )
        let result = EmittedOracle.Evaluate(
            text + "\nRun()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NullableManagedReferenceCastUsesIntrinsicSyntax() {
        const source = `#nullable enable
using Gsharp.Values;
namespace ManagedCastTranslation;
public class Probe {
    public static ManagedRef<int>? Lift(ManagedRef<int> value) =>
        (ManagedRef<int>?)value;
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedCast.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("cast[managed[int32]?](value)", text)
        let result = EmittedOracle.Evaluate(text, []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
    }

    @Fact
    func NestedDeconstructedForEachProjectsManagedReferenceTupleLeaves() {
        const source = `using Gsharp.Values;
namespace ManagedNestedTupleForEachTranslation;
public class Probe {
    public static int Run() {
        int[] values = { 40 };
        var pairs = new (int Head, (ManagedRef<int> Reference, int Tail))[1];
        pairs[0] = (2, (ManagedRef<int>.FromArray(values, 0), 0));
        foreach (var (head, (reference, _)) in pairs) {
            return head + reference.Borrow();
        }
        return 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedNestedTupleForEach.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("for (head, referenceTuple) in pairs", text, StringComparison.Ordinal)
        Assert.Contains("let (reference, _) = referenceTuple", text, StringComparison.Ordinal)
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
    func SwitchPositionalRecordAndDeconstructBindersProjectManagedReferences() {
        const source = `#nullable enable
using Gsharp.Values;
namespace ManagedArraySwitchPositionalRecordAndDeconstruct;
public sealed record Holder<T>(T First, int Second);
public sealed record NullableHolder<T>(T? First, int Second);
public sealed class PairBox<T> {
    public T First { get; }
    public int Second { get; }
    public PairBox(T[] items, int second) {
        this.First = items[0];
        this.Second = second;
    }
    public void Deconstruct(out T first, out int second) {
        first = this.First;
        second = this.Second;
    }
}
public class Probe {
    private static Holder<T> Wrap<T>(T first, int second) => new Holder<T>(first, second);

    public static int Run() {
        int[] values = { 20, 12, 10 };
        var firstSource = new ManagedRef<int>[1];
        firstSource[0] = ManagedRef<int>.FromArray(values, 0);
        var secondSource = new ManagedRef<int>[1];
        secondSource[0] = ManagedRef<int>.FromArray(values, 1);
        var holder = Wrap(firstSource[0], 1);
        var box = new PairBox<ManagedRef<int>>(secondSource, 2);
        var nullableHolder = new NullableHolder<ManagedRef<int>>(
            ManagedRef<int>.FromArray(values, 2),
            3);
        int fromRecord = holder switch {
            (var recordItem, _) => recordItem.Borrow(),
        };
        int fromDeconstruct = 0;
        switch (box) {
            case (var boxItem, _):
                fromDeconstruct = boxItem.Borrow();
                break;
        }
        int fromNullableSlot = nullableHolder switch {
            (var nullableItem, _) => nullableItem!.Borrow(),
        };
        return fromRecord + fromDeconstruct + fromNullableSlot;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArraySwitchPositionalRecordAndDeconstruct.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("recordItem!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("boxItem!!.Borrow()", text, StringComparison.Ordinal)
        Assert.Contains("nullableItem!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ExpressionTreeQueryProviderProjectsRangeVariableElementType() {
        const source = `using System;
using System.Linq.Expressions;
using Gsharp.Values;
namespace ManagedArrayExpressionTreeQuery;
public sealed class QuerySource<T, TTag> {
    private readonly T item;
    public QuerySource(T[] items) => this.item = items[0];
    public TResult Select<TResult>(Expression<Func<T, TResult>> selector) =>
        selector.Compile()(this.item);
}
public sealed class TaggedQuery<TTag, T> {
    public readonly TTag Tag;
    private readonly T item;
    public TaggedQuery(TTag tag, T[] items) {
        this.Tag = tag;
        this.item = items[0];
    }
}
public static class DelegateQueryExtensions {
    public static TResult Select<T, TResult>(
        this Func<int, T> source,
        Expression<Func<T, TResult>> selector) =>
        selector.Compile()(source(0));

    public static TResult Select<TTag, T, TResult>(
        this TaggedQuery<TTag, T> source,
        Expression<Func<TTag, TResult>> selector) =>
        selector.Compile()(source.Tag);
}
public class Probe {
    private static int Read(ManagedRef<int> reference) => reference.Borrow();
    private static Func<int, T> WrapDelegate<T>(T[] items) => index => items[index];

    public static int Run() {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        source[0] = ManagedRef<int>.FromArray(values, 0);
        var query = new QuerySource<ManagedRef<int>, int>(source);
        var delegateQuery = WrapDelegate(source);
        var taggedQuery = new TaggedQuery<int, ManagedRef<int>>(5, source);
        return (from item in query select Read(item))
            + (from delegateItem in delegateQuery select Read(delegateItem))
            + (from tagItem in taggedQuery select tagItem);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayExpressionTreeQuery.cs", source)},
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
        Assert.True(text.Contains("(item managed[int32]?) -> Read(item!!)", StringComparison.Ordinal), text)
        Assert.True(
            text.Contains("(delegateItem managed[int32]?) -> Read(delegateItem!!)", StringComparison.Ordinal),
            text
        )
        Assert.True(text.Contains("(tagItem int32) -> tagItem", StringComparison.Ordinal), text)
    }

    @Fact
    func ForEachAndQueryReferenceConversionPreservesNestedProjectedHierarchy() {
        const source = `#nullable enable
using System.Collections.Generic;
using System.Linq;
using Gsharp.Values;
namespace ManagedArrayReferenceConversionNestedProjection;
public interface IBox<out T> {
}
public interface IValueBox<out T> : IBox<T> {
    T Value { get; }
}
public class BaseBox<T> : IBox<BaseBox<T>>, IValueBox<T> {
    public T Value { get; }
    public BaseBox(T[] items) => this.Value = items[0];
}
public sealed class Box<T> : BaseBox<T> {
    public Box(T[] items) : base(items) { }
}
public class Probe {
    private static List<Box<T>> WrapBoxes<T>(T[] items) => new List<Box<T>> { new Box<T>(items) };

    public static int Run() {
        int[] values = { 20, 22 };
        var firstSource = new ManagedRef<int>[1];
        firstSource[0] = ManagedRef<int>.FromArray(values, 0);
        var secondSource = new ManagedRef<int>[1];
        secondSource[0] = ManagedRef<int>.FromArray(values, 1);
        var boxes = WrapBoxes(firstSource);
        var secondBoxes = WrapBoxes(secondSource);
        int sum = 0;
        foreach (IValueBox<ManagedRef<int>> box in boxes) {
            sum += box.Value.Borrow();
        }
        foreach (IBox<ManagedRef<int>> marker in boxes) {
            sum += marker.GetHashCode() >= int.MinValue ? 0 : 1;
        }
        foreach (IBox<object> objBox in boxes) {
            sum += objBox.GetHashCode() >= int.MinValue ? 0 : 1;
        }
        sum += (from BaseBox<ManagedRef<int>> box in secondBoxes
                select box.Value.Borrow()).Single();
        return sum;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayReferenceConversionNestedProjection.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.True(text.Contains("for box IValueBox[managed[int32]?] in boxes", StringComparison.Ordinal), text)
        Assert.True(text.Contains("for marker IBox[managed[int32]?] in boxes", StringComparison.Ordinal), text)
        Assert.True(text.Contains("for objBox IBox[object] in boxes", StringComparison.Ordinal), text)
        Assert.True(
            text.Contains("(box BaseBox[managed[int32]?]) -> box.Value!!.Borrow()", StringComparison.Ordinal),
            text
        )
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    shared {
        private func TranslatePlain(source string)(
            Text string,
            Context TranslationContext
        ) -> ManagedReferenceTranslationTests.TranslatePlain(source)
    }
}
