// <copyright file="ManagedReferenceLambdaCallbackTranslationTests.cs" company="GSharp">
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

class ManagedReferenceLambdaCallbackTranslationTests {
    @Fact
    func ProjectedMethodResultDoesNotChangeFixedExpressionLambdaReturn() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedExpressionLambdaReturn.cs", source)},
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
    func ProjectedMethodResultCanDefineNaturalExpressionLambdaReturn() {
        const source = `using Gsharp.Values;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNaturalExpressionLambdaReturn.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Wrap(Source)", text, StringComparison.Ordinal)
        Assert.DoesNotContain("factory()!!.", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ProjectedMethodResultCanDefineInferredGenericLambdaReturn() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayInferredGenericLambdaReturn.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Wrap(Source)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionFlowsThroughCallbackReturn() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayCallbackReturn.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Equal(2, text.Split("Create[managed[int32]?]", StringSplitOptions.None).Length - 1)
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
    func ManagedReferenceArrayProjectionRejectsFixedLambdaResultStorage() {
        const source = `using System;
using Gsharp.Values;
namespace ManagedArrayFixedLambdaResult;
public class Probe {
    private static ManagedRef<int> Create(Func<ManagedRef<int>> factory) =>
        factory();

    public static ManagedRef<int> Run() {
        var source = new ManagedRef<int>[1];
        return Create(() => source[0]);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedLambdaResult.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("callback return storage", StringComparison.Ordinal)
        )
    }

    @Fact
    func InferredDelegateInvocationKeepsProjectedLambdaReturn() {
        const source = `using Gsharp.Values;
namespace ManagedArrayInferredDelegateReturn;
public class Probe {
    public static int Run() {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        source[0] = ManagedRef<int>.FromArray(values, 0);
        var get = () => source[0];
        return get().Borrow();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayInferredDelegateReturn.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("get()!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func InferredAsyncDelegateInvocationKeepsTaskEnvelope() {
        const source = `using System.Threading.Tasks;
using Gsharp.Values;
namespace ManagedArrayInferredAsyncDelegateReturn;
public class Probe {
    public static async Task<int> Run() {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        source[0] = ManagedRef<int>.FromArray(values, 0);
        var get = async () => {
            await Task.Yield();
            return source[0];
        };
        return (await get()).Borrow();
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayInferredAsyncDelegateReturn.cs", source)},
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
        Assert.Contains("(await get())!!.Borrow()", text, StringComparison.Ordinal)
    }

    @Fact
    func ManagedReferenceArrayProjectionRejectsMixedCallbackReturnArms() {
        const source = `using System;
using Gsharp.Values;
namespace ManagedArrayMixedLambdaReturns;
public class Probe {
    private static (T Reference, int Value) Apply<T>(
        T[] source,
        Func<bool, (T Reference, int Value)> factory) =>
        factory(true);

    public static void Run() {
        int[] values = { 42 };
        var source = new ManagedRef<int>[1];
        source[0] = ManagedRef<int>.FromArray(values, 0);
        var projectedResults =
            new (ManagedRef<int> Reference, int Value)[1];
        var fixedResult =
            (ManagedRef<int>.FromArray(values, 0), 0);
        _ = Apply(source, projected => {
            if (projected) return projectedResults[0];
            return fixedResult;
        });
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayMixedLambdaReturns.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("callback return storage", StringComparison.Ordinal)
        )
    }

    @Fact
    func ProjectedInlineLambdaAcceptsReturnedProjectedParameter() {
        const source = `using System;
using System.Collections.Generic;
using Gsharp.Values;
namespace ManagedArrayInlineLambdaParameterReturn;
public class Probe {
    private static List<T> Apply<T>(
        T[] source,
        Func<List<T>, List<T>> selector) =>
        selector(new List<T> { source[0] });

    public static int Run() {
        var source = new ManagedRef<int>[1];
        var result = Apply(source, projectedValues => projectedValues);
        return result[0] == null ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayInlineLambdaParameterReturn.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionRejectsFixedMethodGroup() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayFixedMethodGroup.cs", source)},
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
        Assert.DoesNotContain("Apply[managed[int32]?](source, Check)", text, StringComparison.Ordinal)
    }

    @Fact
    func ReducedExtensionDelegateArgumentsUseReducedParameterOrdinals() {
        const source = `using System;
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
}`
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ReducedExtensionDelegateOrdinals.cs", source)}
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("(t Track) -> t.Items()", text, StringComparison.Ordinal)
        Assert.Contains("(item int32) -> item", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(text + "\nProbe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionUpdatesParameterlessAnonymousDelegate() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedAnonymousDelegate.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("_ Gsharp.Values.ManagedRef[int32]?", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionAllowsNaturalLambdaDelegateTarget() {
        const source = `using System;
using Gsharp.Values;
namespace ManagedArrayNaturalLambdaDelegate;
public class Probe {
    private static bool IsNil<T>(T[] items, Delegate callback) =>
        items[0] is null;

    public static bool Run() {
        var source = new ManagedRef<int>[1];
        return IsNil(source, () => 1);
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayNaturalLambdaDelegate.cs", source)},
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
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionUpdatesLambdaParameterType() {
        const source = `using System.Linq;
using Gsharp.Values;
namespace ManagedArrayProjectedLambda;
public class Probe {
    public static int Run() {
        var source = new ManagedRef<int>[1];
        return source.Select(item => item == null).First() ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedLambda.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("item Gsharp.Values.ManagedRef[int32]?", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ProjectedLambdaParameterTypeFlowsIntoCallArguments() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedLambdaArgument.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Read(item!!)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ExpressionTreeCallbacksUseProjectedManagedReferenceContracts() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedExpressionTreeCallbacks.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("item Gsharp.Values.ManagedRef[int32]?", text, StringComparison.Ordinal)
        Assert.Contains("Create[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("created!!.Borrow()", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NativeManagedReferenceNullTestsPreserveCapturedAssignmentFacts() {
        const source = `#nullable enable
using System;
using Gsharp.Values;
namespace ManagedReferenceNullTestEffects;
public class Probe {
    private static Action? clear;
    public static bool Run() {
        string? text = null;
        ManagedRef<int>? item = null;
        clear = () => text = null;
        text = "x";
        var isNil = item == null;
        return (text?[0]).HasValue && isNil;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedReferenceNullTestEffects.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.DoesNotContain("text?[0]", text, StringComparison.Ordinal)
        Assert.Contains("text[0]", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionUpdatesMethodGroupTarget() {
        const source = `#nullable enable
using System.Linq;
using Gsharp.Values;
namespace ManagedArrayProjectedMethodGroup;
public class Probe {
    private static bool IsNil<T>(T item) => item == null;

    public static int Run() {
        var source = new ManagedRef<int>[1];
        return source.Select(IsNil<ManagedRef<int>>).First() ? 42 : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedMethodGroup.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("managed[int32]?", text, StringComparison.Ordinal)
        Assert.Contains("IsNil[managed[int32]?]", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionUpdatesReturnOnlyMethodGroup() {
        const source = `#nullable enable
using System;
using Gsharp.Values;
namespace ManagedArrayProjectedReturnOnlyMethodGroup;
public static class Holder<T> {
    public static T[] Produce() => new T[1];
}
public class Probe {
    private static T[] Produce<T>() => new T[1];
    private static string[] EmptyStrings() => Array.Empty<string>();

    private static bool Apply<T>(
        T[] source,
        Func<T[]> factory) =>
        factory()[0] == null;

    private static bool ApplyOrdinary(Func<string[]> factory) =>
        factory().Length == 0;

    public static int Run() {
        var source = new ManagedRef<int>[1];
        return Apply(source, Produce<ManagedRef<int>>)
            && Apply(source, Holder<ManagedRef<int>>.Produce)
            && ApplyOrdinary(EmptyStrings)
            ? 42
            : 0;
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedReturnOnlyMethodGroup.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("Produce[managed[int32]?]", text, StringComparison.Ordinal)
        Assert.Contains("Holder[managed[int32]?].Produce", text, StringComparison.Ordinal)
        Assert.Contains("ApplyOrdinary(EmptyStrings)", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionUpdatesMethodGroupContainingType() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedMethodGroupContainingType.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("Holder[managed[int32]?].IsNil", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionUpdatesOuterMethodGroupContainingType() {
        const source = `using System.Linq;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedOuterMethodGroupContainingType.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("Outer[managed[int32]?].Inner.IsNil", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ManagedReferenceArrayProjectionRejectsConflictingMethodGroupParameters() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayConflictingMethodGroupParameters.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("conflicting types for type parameter", StringComparison.Ordinal)
        )
    }

    @Fact
    func LambdaReturnUsesEmittedArrayElementProjection() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayLambdaReturnProjection.cs", source)},
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
    func ProjectedLambdaResultAllowsImplicitDerivedToBaseConversion() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayProjectedLambdaDerivedResult.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Derived[managed[int32]?](items[0])", text, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            text + "\nProbe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ExpressionTreeCallbackUsesProjectedDelegateResult() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedArrayExpressionTreeCallback.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("func () managed[int32]?", text, StringComparison.Ordinal)
        Assert.DoesNotContain("source[0]!!", text, StringComparison.Ordinal)
    }

    @Fact
    func ProjectedDelegateVariableInvocationUsesInvokeReturnType() {
        const source = `using System;
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
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("ManagedProjectedDelegateInvocation.cs", source)},
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.True(text.Contains("factory()!!.Borrow()", StringComparison.Ordinal), text)
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
