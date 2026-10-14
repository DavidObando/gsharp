// <copyright file="Issue2504NamedDelegateReturnTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2504: source named-delegate return contracts participate in the
/// oblivious callable-return taint graph without borrowing callable-envelope
/// nullability or changing delegate parameter variance.
class Issue2504NamedDelegateReturnTaintTranslationTests {
    @Fact
    func MinimalMethodGroup_ConstructorAndConditionalInvoke_ConvergeBothDimensions() {
        let printed = TranslateOblivious(`namespace Demo;

public sealed class Result { }
public delegate Result Callback();

public sealed class Holder
{
    private readonly Callback callback;

    public Holder(Callback callback) => this.callback = callback;

    public Result Run() => callback?.Invoke();
}

public static class Repro
{
    private static Result Produce() => null;

    public static Holder Create() => new Holder(Produce);
}`)
        Assert.Contains("delegate Callback() Result?;", printed, StringComparison.Ordinal)
        // Issue #2835: source-declared delegates keep their nominal name, so the
        // return promotion reads off the `type Callback = ...` declaration above
        // and the field carries only its own envelope nullability.
        Assert.Contains("private let callback Callback?", printed, StringComparison.Ordinal)
        Assert.Contains("func Produce() Result? -> nil", printed, StringComparison.Ordinal)
        Assert.Contains("Holder(Produce)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Produce!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func EveryConversionSeam_MethodGroupsAndLambdas_JoinOneContract() {
        let printed = TranslateOblivious(`namespace Demo;

public sealed class Result { }
public delegate Result Callback(bool enforce = false);

public static class Repro
{
    private static Callback field = Clean;
    public static Callback Property { get; } = _ => null;
    public static event Callback Changed;

    private static Result Clean(bool enforce) => new Result();
    private static Result Produce(bool enforce) => null;

    public static void Accept(Callback callback) { }
    public static Callback Return() => Produce;

    public static void Wire()
    {
        Callback local = Clean;
        local = Produce;
        Accept(value => value ? null : new Result());
        Changed += Produce;
    }
}`, "G# currently does not bind source event names inside shared method bodies.")
        Assert.Contains("delegate Callback(enforce bool = false) Result?;", printed, StringComparison.Ordinal)
        Assert.Contains("func Clean(enforce bool) Result?", printed, StringComparison.Ordinal)
        Assert.Contains("func Produce(enforce bool) Result?", printed, StringComparison.Ordinal)
        // Issue #2835: nominal, not erased. The `Result?` return promotion lives
        // on the `type Callback` declaration asserted above; neither the
        // parameter nor the return borrows callable-envelope nullability.
        Assert.Contains("func Accept(callback Callback)", printed, StringComparison.Ordinal)
        Assert.Contains("func Return() Callback", printed, StringComparison.Ordinal)
        Assert.Contains("event Changed Callback", printed, StringComparison.Ordinal)
    }

    @Fact
    func CallableEnvelopeAndReturnNullability_RemainIndependent() {
        let printed = TranslateOblivious(`namespace Demo;

public sealed class Result { }
public delegate Result CleanCallback();
public delegate Result NullableResultCallback();
public delegate Result OptionalNullableResultCallback();

public static class Repro
{
    private static CleanCallback clean = () => new Result();
    private static CleanCallback optionalClean = () => new Result();
    private static NullableResultCallback nullableResult = () => null;
    private static OptionalNullableResultCallback optionalNullableResult = () => null;

    public static Result RunOptionalClean() => optionalClean?.Invoke();
    public static Result RunOptionalNullable() => optionalNullableResult?.Invoke();
}`)
        Assert.Contains("delegate CleanCallback() Result;", printed, StringComparison.Ordinal)
        Assert.Contains("delegate NullableResultCallback() Result?;", printed, StringComparison.Ordinal)
        Assert.Contains("delegate OptionalNullableResultCallback() Result?;", printed, StringComparison.Ordinal)
        // Issue #2835: with nominal delegate names the two dimensions stay
        // independently observable -- the RETURN promotion is carried by the
        // delegate declaration (`CleanCallback` vs `NullableResultCallback`
        // above) and the ENVELOPE promotion by the trailing `?` on each field.
        // All four combinations are distinct:
        Assert.Contains("clean CleanCallback =", printed, StringComparison.Ordinal)
        Assert.Contains("optionalClean CleanCallback? =", printed, StringComparison.Ordinal)
        Assert.Contains("nullableResult NullableResultCallback =", printed, StringComparison.Ordinal)
        Assert.Contains("optionalNullableResult OptionalNullableResultCallback? =", printed, StringComparison.Ordinal)
    }

    @Fact
    func GenericAndStructuredReturns_ReuseExistingReturnShapePromotion() {
        let printed = TranslateOblivious(`using System.Threading.Tasks;

namespace Demo;

public sealed class Result { }
public sealed class Box<T> { }

public delegate T GenericCallback<T>() where T : class;
public delegate Task<Result> TaskCallback();
public delegate ValueTask<Result> ValueTaskCallback();
public delegate (Result First, Result Second) TupleCallback();
public delegate (Result First, Result Second) LambdaTupleCallback();
public delegate Result[] ArrayCallback();
public delegate Box<Result> NestedCallback();

public static class Repro
{
    private static T GenericProduce<T>() where T : class => null;
    private static async Task<Result> TaskProduce() => null;
    private static async ValueTask<Result> ValueTaskProduce() => null;
    private static (Result, Result) TupleProduce()
    {
        Result first = null;
        return (first, new Result());
    }
    private static Result[] ArrayProduce() => null;
    private static Box<Result> NestedProduce() => null;

    private static GenericCallback<Result> generic = GenericProduce<Result>;
    private static TaskCallback task = TaskProduce;
    private static ValueTaskCallback valueTask = ValueTaskProduce;
    private static TupleCallback tuple = TupleProduce;
    private static LambdaTupleCallback lambdaTuple = () =>
    {
        Result first = null;
        return (first, new Result());
    };
    private static ArrayCallback array = ArrayProduce;
    private static NestedCallback nested = NestedProduce;
}`, "G# cannot yet convert this open generic method group to the constructed named delegate.")
        Assert.Contains("() T?;", printed, StringComparison.Ordinal)
        Assert.Contains("delegate TaskCallback() Task[Result?];", printed, StringComparison.Ordinal)
        Assert.Contains("delegate ValueTaskCallback() ValueTask[Result?];", printed, StringComparison.Ordinal)
        Assert.Contains("delegate TupleCallback() (First Result?, Second Result);", printed, StringComparison.Ordinal)
        Assert.Contains(
            "delegate LambdaTupleCallback() (First Result?, Second Result);",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("delegate ArrayCallback() []?Result;", printed, StringComparison.Ordinal)
        Assert.Contains("delegate NestedCallback() Box[Result]?;", printed, StringComparison.Ordinal)
    }

    @Fact
    func InterfaceBaseAndParameterVariance_ConvergeOnlyReturnContracts() {
        let printed = TranslateOblivious(`namespace Demo;

public sealed class Result { }
public delegate Result Callback();
public delegate Result Variant(string value);

public interface IProducer
{
    Result Get();
}

public sealed class InterfaceProducer : IProducer
{
    public Result Get() => null;
}

public abstract class BaseProducer
{
    public abstract Result Get();
}

public sealed class DerivedProducer : BaseProducer
{
    public override Result Get() => null;
}

public static class Repro
{
    private static Result VariantProduce(object value) => null;

    public static Callback FromInterface(IProducer producer) => producer.Get;
    public static Callback FromBase(BaseProducer producer) => producer.Get;
    public static Variant Contravariant() => VariantProduce;
}`)
        Assert.Contains("func Get() Result?;", printed, StringComparison.Ordinal)
        Assert.Contains("open func Get() Result?;", printed, StringComparison.Ordinal)
        Assert.Contains("delegate Callback() Result?;", printed, StringComparison.Ordinal)
        Assert.Contains("delegate Variant(value string) Result?;", printed, StringComparison.Ordinal)
        Assert.Contains("func VariantProduce(value object) Result?", printed, StringComparison.Ordinal)
    }

    @Fact
    func CrossProjectProducer_PromotesDelegateInDeclaringProject() {
        let contracts = CreateCompilation("Contracts", `namespace Contracts;

public sealed class Result { }
public delegate Result Callback();`, references: nil, NullableContextOptions.Disable)
        let producer = CreateCompilation("Producer", `using Contracts;

namespace Producer;

public static class Factory
{
    private static Result Produce() => null;
    public static Callback Create() => Produce;
}`, []CompilationReference{contracts.ToMetadataReference()}, NullableContextOptions.Disable)
        let printed = TranslateCompilation(contracts, []CSharpCompilation{contracts, producer})
        Assert.Contains("delegate Callback() Result?;", printed, StringComparison.Ordinal)
    }

    @Fact
    func ReferencedProjectProducer_PromotesConsumerDelegateWithoutCallableAssertion() {
        let producer = CreateCompilation("Producer", `namespace Producer;

public sealed class Result { }

public static class Factory
{
    public static Result Produce() => null;
}`, references: nil, NullableContextOptions.Disable)
        let consumer = CreateCompilation("Consumer", `using Producer;

namespace Consumer;

public delegate Result Callback();

public static class Repro
{
    public static Callback Create() => Factory.Produce;
}`, []CompilationReference{producer.ToMetadataReference()}, NullableContextOptions.Disable)
        let printed = TranslateCompilation(
            consumer,
            []CSharpCompilation{producer, consumer},
            "Consumer-only fixture omits the referenced producer project from emitted G#."
        )
        Assert.Contains("delegate Callback() Result?;", printed, StringComparison.Ordinal)
        Assert.Contains("Factory.Produce", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Factory.Produce!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func NullableEnabledSource_RemainsAnnotationDriven() {
        let printed = Translate(`#nullable enable
namespace Demo;

public sealed class Result { }
public delegate Result Callback();
public delegate Result? NullableCallback();

public static class Repro
{
    private static Result Clean() => new Result();
    private static Result? Maybe() => null;

    public static Callback First() => Clean;
    public static NullableCallback Second() => Maybe;
}`, NullableContextOptions.Enable)
        Assert.Contains("delegate Callback() Result;", printed, StringComparison.Ordinal)
        Assert.Contains("delegate NullableCallback() Result?;", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Clean() Result?", printed, StringComparison.Ordinal)
    }

    shared {
        private func TranslateOblivious(source string, roundTripOnlyReason string? = nil) string -> Translate(
            source,
            NullableContextOptions.Disable,
            roundTripOnlyReason
        )

        private func Translate(
            source string,
            nullableContext NullableContextOptions,
            roundTripOnlyReason string? = nil
        ) string {
            let compilation = CreateCompilation("Issue2504", source, references: nil, nullableContext)
            return TranslateCompilation(compilation, siblingCompilations: nil, roundTripOnlyReason: roundTripOnlyReason)
        }

        private func CreateCompilation(
            assemblyName string,
            source string,
            references IEnumerable[MetadataReference]?,
            nullableContext NullableContextOptions
        ) CSharpCompilation {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let allReferences = CSharpProjectLoader.RuntimeReferences().Concat(
                references ?? Array.Empty[MetadataReference]()
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                allReferences,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    nullableContext
                )
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            return compilation
        }

        private func TranslateCompilation(
            compilation CSharpCompilation,
            siblingCompilations IReadOnlyList[CSharpCompilation]?,
            roundTripOnlyReason string? = nil
        ) string {
            let printed = List[string]()
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                let document = LoadedDocument(tree.FilePath, tree, model)
                let context = TranslationContext(compilation, model, document.FilePath, siblingCompilations)
                let translated = CSharpToGSharpTranslator().TranslateDocument(document, context)
                let text = GSharpPrinter.Print(translated)
                let roundTrip RoundTripResult? = if roundTripOnlyReason == nil {
                    TranslationTestValidation.AssertBinds(text)
                } else {
                    TranslationTestValidation.ValidateRoundTripOnly(text, roundTripOnlyReason)
                }
                Assert.True(
                    roundTrip!!.Success,
                    "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + text
                )
                printed.Add(text)
            }
            return string.Join(Environment.NewLine, printed)
        }
    }
}
