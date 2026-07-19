// <copyright file="Issue2504NamedDelegateReturnTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2504: source named-delegate return contracts participate in the
/// oblivious callable-return taint graph without borrowing callable-envelope
/// nullability or changing delegate parameter variance.
/// </summary>
public sealed class Issue2504NamedDelegateReturnTaintTranslationTests
{
    [Fact]
    public void MinimalMethodGroup_ConstructorAndConditionalInvoke_ConvergeBothDimensions()
    {
        string printed = TranslateOblivious("""
            namespace Demo;

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
            }
            """);

        Assert.Contains("type Callback = delegate func() Result?", printed, StringComparison.Ordinal);
        Assert.Contains("callback (() -> Result?)?", printed, StringComparison.Ordinal);
        Assert.Contains("func Produce() Result? -> nil", printed, StringComparison.Ordinal);
        Assert.Contains("Holder(Produce)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Produce!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void EveryConversionSeam_MethodGroupsAndLambdas_JoinOneContract()
    {
        string printed = TranslateOblivious("""
            namespace Demo;

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
            }
            """);

        Assert.Contains("type Callback = delegate func(enforce bool = false) Result?", printed, StringComparison.Ordinal);
        Assert.Contains("func Clean(enforce bool) Result?", printed, StringComparison.Ordinal);
        Assert.Contains("func Produce(enforce bool) Result?", printed, StringComparison.Ordinal);
        Assert.Contains("func Accept(callback (bool) -> Result?)", printed, StringComparison.Ordinal);
        Assert.Contains("func Return() (bool) -> Result?", printed, StringComparison.Ordinal);
        Assert.Contains("event Changed Callback", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void CallableEnvelopeAndReturnNullability_RemainIndependent()
    {
        string printed = TranslateOblivious("""
            namespace Demo;

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
            }
            """);

        Assert.Contains("type CleanCallback = delegate func() Result", printed, StringComparison.Ordinal);
        Assert.Contains("type NullableResultCallback = delegate func() Result?", printed, StringComparison.Ordinal);
        Assert.Contains("type OptionalNullableResultCallback = delegate func() Result?", printed, StringComparison.Ordinal);
        Assert.Contains("optionalClean (() -> Result)?", printed, StringComparison.Ordinal);
        Assert.Contains("nullableResult () -> Result?", printed, StringComparison.Ordinal);
        Assert.Contains("optionalNullableResult (() -> Result?)?", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericAndStructuredReturns_ReuseExistingReturnShapePromotion()
    {
        string printed = TranslateOblivious("""
            using System.Threading.Tasks;

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
            }
            """);

        Assert.Contains("delegate func() T?", printed, StringComparison.Ordinal);
        Assert.Contains("type TaskCallback = delegate func() Task[Result?]", printed, StringComparison.Ordinal);
        Assert.Contains("type ValueTaskCallback = delegate func() ValueTask[Result?]", printed, StringComparison.Ordinal);
        Assert.Contains("type TupleCallback = delegate func() (Result?, Result)", printed, StringComparison.Ordinal);
        Assert.Contains("type LambdaTupleCallback = delegate func() (Result?, Result)", printed, StringComparison.Ordinal);
        Assert.Contains("type ArrayCallback = delegate func() []?Result", printed, StringComparison.Ordinal);
        Assert.Contains("type NestedCallback = delegate func() Box[Result]?", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void InterfaceBaseAndParameterVariance_ConvergeOnlyReturnContracts()
    {
        string printed = TranslateOblivious("""
            namespace Demo;

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
            }
            """);

        Assert.Contains("func Get() Result?;", printed, StringComparison.Ordinal);
        Assert.Contains("open func Get() Result?;", printed, StringComparison.Ordinal);
        Assert.Contains("type Callback = delegate func() Result?", printed, StringComparison.Ordinal);
        Assert.Contains("type Variant = delegate func(value string) Result?", printed, StringComparison.Ordinal);
        Assert.Contains("func VariantProduce(value object) Result?", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void CrossProjectProducer_PromotesDelegateInDeclaringProject()
    {
        CSharpCompilation contracts = CreateCompilation(
            "Contracts",
            """
            namespace Contracts;

            public sealed class Result { }
            public delegate Result Callback();
            """,
            references: null,
            NullableContextOptions.Disable);
        CSharpCompilation producer = CreateCompilation(
            "Producer",
            """
            using Contracts;

            namespace Producer;

            public static class Factory
            {
                private static Result Produce() => null;
                public static Callback Create() => Produce;
            }
            """,
            new[] { contracts.ToMetadataReference() },
            NullableContextOptions.Disable);

        string printed = TranslateCompilation(contracts, new[] { contracts, producer });

        Assert.Contains("type Callback = delegate func() Result?", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ReferencedProjectProducer_PromotesConsumerDelegateWithoutCallableAssertion()
    {
        CSharpCompilation producer = CreateCompilation(
            "Producer",
            """
            namespace Producer;

            public sealed class Result { }

            public static class Factory
            {
                public static Result Produce() => null;
            }
            """,
            references: null,
            NullableContextOptions.Disable);
        CSharpCompilation consumer = CreateCompilation(
            "Consumer",
            """
            using Producer;

            namespace Consumer;

            public delegate Result Callback();

            public static class Repro
            {
                public static Callback Create() => Factory.Produce;
            }
            """,
            new[] { producer.ToMetadataReference() },
            NullableContextOptions.Disable);

        string printed = TranslateCompilation(consumer, new[] { producer, consumer });

        Assert.Contains("type Callback = delegate func() Result?", printed, StringComparison.Ordinal);
        Assert.Contains("Factory.Produce", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Factory.Produce!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableEnabledSource_RemainsAnnotationDriven()
    {
        string printed = Translate(
            """
            #nullable enable
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
            }
            """,
            NullableContextOptions.Enable);

        Assert.Contains("type Callback = delegate func() Result", printed, StringComparison.Ordinal);
        Assert.Contains("type NullableCallback = delegate func() Result?", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Clean() Result?", printed, StringComparison.Ordinal);
    }

    private static string TranslateOblivious(string source) =>
        Translate(source, NullableContextOptions.Disable);

    private static string Translate(string source, NullableContextOptions nullableContext)
    {
        CSharpCompilation compilation = CreateCompilation(
            "Issue2504",
            source,
            references: null,
            nullableContext);
        return TranslateCompilation(compilation, siblingCompilations: null);
    }

    private static CSharpCompilation CreateCompilation(
        string assemblyName,
        string source,
        IEnumerable<MetadataReference> references,
        NullableContextOptions nullableContext)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: assemblyName + ".cs");
        var allReferences = CSharpProjectLoader.RuntimeReferences()
            .Concat(references ?? Array.Empty<MetadataReference>());
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            allReferences,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(nullableContext));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
        return compilation;
    }

    private static string TranslateCompilation(
        CSharpCompilation compilation,
        IReadOnlyList<CSharpCompilation> siblingCompilations)
    {
        var printed = new List<string>();
        foreach (SyntaxTree tree in compilation.SyntaxTrees)
        {
            SemanticModel model = compilation.GetSemanticModel(tree);
            var document = new LoadedDocument(tree.FilePath, tree, model);
            var context = new TranslationContext(
                compilation,
                model,
                document.FilePath,
                siblingCompilations);
            CompilationUnit translated = new CSharpToGSharpTranslator().TranslateDocument(document, context);
            string text = GSharpPrinter.Print(translated);
            RoundTripResult roundTrip = GSharpRoundTrip.Validate(text);
            Assert.True(
                roundTrip.Success,
                "Translated G# must round-trip. Errors:\n" +
                    string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + text);
            printed.Add(text);
        }

        return string.Join(Environment.NewLine, printed);
    }
}
