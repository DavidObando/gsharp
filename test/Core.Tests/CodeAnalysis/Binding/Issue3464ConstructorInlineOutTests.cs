// <copyright file="Issue3464ConstructorInlineOutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue3464ConstructorInlineOutTests
{
    [Fact]
    public void ImportedMutex_MixedNamedAndPositionalOutVar_BindsAndRuns()
    {
        var result = Evaluate("""
            import System.Threading

            let guardName string? = nil
            let processGuard = Mutex(initiallyOwned: false, guardName, out var createdNew)
            processGuard.Dispose()
            createdNew
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ImportedMutex_ReorderedNamedOutLet_BindsAndRuns()
    {
        var result = Evaluate("""
            import System.Threading

            let processGuard = Mutex(
                createdNew: out let createdNew,
                name: nil,
                initiallyOwned: false)
            processGuard.Dispose()
            createdNew
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ImportedMutex_ExplicitlyTypedOutVar_BindsAndRuns()
    {
        var result = Evaluate("""
            import System.Threading

            let processGuard = Mutex(false, nil, out var createdNew bool)
            processGuard.Dispose()
            createdNew
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ImportedMutex_OutDiscard_BindsAndPreservesResultType()
    {
        var result = Evaluate("""
            import System.Threading

            let processGuard = Mutex(false, nil, out _)
            processGuard.Dispose()
            42
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ImportedGenericConstructor_InfersOutVarType()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            let fixture = Issue3464GenericConstructor[int32](out var value)
            value + fixture.Value
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(84, result.Value);
    }

    [Fact]
    public void ImportedNestedConstructor_InfersOutVarType()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            let fixture = Issue3464Outer.Nested(out var value)
            value + fixture.Value
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(84, result.Value);
    }

    [Fact]
    public void SourceGenericConstructor_WrongTypeArgumentArity_DeclaresOutLocal()
    {
        var result = Evaluate("""
            class WrongArityGenericOutBox[T] {
                init(seed int32, out flag bool) {
                    flag = seed > 0
                }
            }

            WrongArityGenericOutBox[int32, int32](5, out var flag)
            flag
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0148");
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Id is "GS0102" or "GS0125");
    }

    [Fact]
    public void SourceGenericConstructor_UnknownTypeArgument_DeclaresOutLocal()
    {
        var result = Evaluate("""
            class UnknownTypeGenericOutBox[T] {
                init(seed int32, out flag bool) {
                    flag = seed > 0
                }
            }

            UnknownTypeGenericOutBox[MissingIssue3464Type](5, out var flag)
            flag
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0113");
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Id is "GS0102" or "GS0125");
    }

    [Fact]
    public void SourceGenericConstructor_UninferableOutDeclarations_DoNotDuplicateLocals()
    {
        var result = Evaluate("""
            class UninferableVarGenericOutBox[T] {
                init(out value T) { }
            }

            class UninferableLetGenericOutBox[T] {
                init(out value T) { }
            }

            class UninferableDiscardGenericOutBox[T] {
                init(out value T) { }
            }

            UninferableVarGenericOutBox(out var varValue)
            varValue
            UninferableLetGenericOutBox(out let letValue)
            letValue
            UninferableDiscardGenericOutBox(out _)
            """);

        Assert.Equal(3, result.Diagnostics.Count(diagnostic => diagnostic.Id == "GS0151"));
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Id is "GS0102" or "GS0125");
    }

    [Fact]
    public void SourceGenericConstructor_ConcreteOutVar_BindsAndRuns()
    {
        var result = Evaluate("""
            class ConcreteGenericOutBox[T] {
                init(seed T, out value T) {
                    value = seed
                }
            }

            ConcreteGenericOutBox[int32](42, out var value)
            value
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SourceConstructor_ReorderedNamedOutVar_IsVisibleAndAssigned()
    {
        var result = Evaluate("""
            class Box {
                var Value int32

                init(prefix int32, out result int32) {
                    result = prefix + 2
                    Value = result
                }
            }

            let box = Box(result: out var result, prefix: 40)
            result + box.Value
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(84, result.Value);
    }

    [Fact]
    public void SourceConstructor_OutVar_SelectsOutOverRefAndIn()
    {
        var result = Evaluate("""
            class RefKindChoice {
                var Tag int32

                init(out value int32) {
                    value = 41
                    Tag = 1
                }

                init(ref value string) {
                    Tag = 2
                }

                init(in value bool) {
                    Tag = 3
                }
            }

            let choice = RefKindChoice(out var value)
            value + choice.Tag
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SourceConstructor_ReorderedAndMixedNamedOutVar_SelectOutOverRefAndIn()
    {
        var result = Evaluate("""
            class NamedRefKindChoice {
                var Tag int32

                init(prefix int32, out value int32) {
                    value = prefix + 1
                    Tag = 1
                }

                init(prefix int32, ref value string) {
                    Tag = 2
                }

                init(prefix int32, in value bool) {
                    Tag = 3
                }
            }

            let reordered = NamedRefKindChoice(value: out var first, prefix: 40)
            let mixed = NamedRefKindChoice(prefix: 20, out var second)
            first + second + reordered.Tag + mixed.Tag
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(64, result.Value);
    }

    [Fact]
    public void SourceConstructor_OutLetAndDiscard_SelectOutOverRefAndIn()
    {
        var result = Evaluate("""
            class LetDiscardRefKindChoice {
                var Tag int32

                init(out value int32) {
                    value = 20
                    Tag = 1
                }

                init(ref value string) {
                    Tag = 2
                }

                init(in value bool) {
                    Tag = 3
                }
            }

            let kept = LetDiscardRefKindChoice(out let value)
            let discarded = LetDiscardRefKindChoice(out _)
            value + kept.Tag + discarded.Tag
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(22, result.Value);
    }

    [Fact]
    public void SourceConstructor_ExplicitTypedOut_SelectsMatchingOutOverRef()
    {
        var result = Evaluate("""
            class TypedRefKindChoice {
                var Tag int32

                init(out value int32) {
                    value = 40
                    Tag = 2
                }

                init(out value string) {
                    value = ""
                    Tag = 3
                }

                init(ref value bool) {
                    Tag = 4
                }
            }

            let choice = TypedRefKindChoice(out var value int32)
            value + choice.Tag
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SourceConstructor_OrdinaryRefAndInCallsStillBind()
    {
        var result = Evaluate("""
            class RefOnly {
                init(ref value string) {
                    value = value + "!"
                }
            }

            class InOnly {
                var Value bool

                init(in value bool) {
                    Value = value
                }
            }

            var text = "ok"
            RefOnly(&text)
            let flag = true
            let captured = InOnly(in flag)
            text.Length + (captured.Value ? 1 : 0)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void ImportedConstructor_OutDeclarationAtValuePosition_ReportsOnlyGs0236()
    {
        var result = Evaluate("""
            import System.Threading

            Mutex(out var invalid, nil, out _)
            """);

        Assert.Equal(new[] { "GS0236" }, result.Diagnostics.Select(diagnostic => diagnostic.Id).Distinct());
    }

    [Fact]
    public void ImportedConstructor_OutDeclarationAtRefPosition_ReportsGs0236()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            Issue3464RefConstructor(out var value)
            """);

        Assert.Equal("GS0236", Assert.Single(result.Diagnostics).Id);
    }

    [Fact]
    public void ImportedConstructor_OutVarOverloads_RemainAmbiguous()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            Issue3464AmbiguousConstructor(out var value)
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0160");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0236");
    }

    [Fact]
    public void ImportedConstructor_ExplicitTypedOutAmbiguity_DoesNotRedeclareLocal()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            Issue3464AmbiguousTypedConstructor(out var value int32)
            value
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0160");
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Id is "GS0102" or "GS0125");
    }

    [Fact]
    public void ImportedConstructor_DuplicateNamedOutVar_DeclaresErrorLocal()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            Issue3464FailureConstructor(value: out var value, value: 1)
            value
            """);

        AssertImportedPrimaryWithoutCascades(result, "GS0245");
    }

    [Fact]
    public void ImportedConstructor_OutVarAtNonOutPosition_DeclaresErrorLocal()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            Issue3464FailureConstructor(out var value, 1)
            value
            """);

        AssertImportedPrimaryWithoutCascades(result, "GS0236");
    }

    [Fact]
    public void ImportedConstructor_ConversionFailure_DeclaresTypedOutLocal()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            Issue3464FailureConstructor(1, out var value, "bad")
            value + 1
            """);

        AssertImportedPrimaryWithoutCascades(result, "GS0130");
    }

    [Fact]
    public void ImportedConstructor_MissingRequiredArgument_DeclaresTypedOutLocal()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            Issue3464FailureConstructor(1, out var value)
            value + 1
            """);

        AssertImportedPrimaryWithoutCascades(result, "GS0130");
    }

    [Fact]
    public void ImportedConstructor_UnknownNamedArgument_DeclaresTypedOutLocal()
    {
        var result = EvaluateFixture("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            Issue3464FailureConstructor(1, value: out var value, missing: 2)
            value + 1
            """);

        AssertImportedPrimaryWithoutCascades(result, "GS0246");
    }

    [Fact]
    public void ImportedMutex_DuplicateNamedOutVar_DeclaresErrorLocal()
    {
        var result = Evaluate("""
            import System.Threading

            Mutex(false, createdNew: out var createdNew, createdNew: out _)
            createdNew
            """);

        AssertImportedPrimaryWithoutCascades(result, "GS0245");
    }

    [Fact]
    public void SourceConstructor_OutDeclarationAtValuePosition_ReportsGs0236()
    {
        var result = Evaluate("""
            class ValueCtor {
                init(value int32) {
                }
            }

            ValueCtor(out var value)
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0236");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0130");
    }

    [Fact]
    public void SourceConstructor_NoOutOverload_ReportsOnlyGs0236AndDeclaresErrorLocal()
    {
        var result = Evaluate("""
            class NoOutChoice {
                init(value int32) {
                }

                init(ref value string) {
                }

                init(in value bool) {
                }
            }

            NoOutChoice(out var value)
            value
            """);

        Assert.Equal("GS0236", Assert.Single(result.Diagnostics).Id);
    }

    [Fact]
    public void SourceConstructor_NamedInlineOutMappedToRef_ReportsOnlyGs0236()
    {
        var result = Evaluate("""
            class NamedNoOutChoice {
                init(out result int32, ref other string) {
                    result = 0
                }
            }

            NamedNoOutChoice(other: out var value, result: out _)
            value
            """);

        Assert.Equal("GS0236", Assert.Single(result.Diagnostics).Id);
    }

    [Fact]
    public void SourceConstructor_Gs0236PointsToActualInvalidInlineOutArgument()
    {
        var result = Evaluate("""
            class LocatedNoOutChoice {
                init(out result int32, ref other string) {
                    result = 0
                }
            }

            LocatedNoOutChoice(result: out _, other: out var invalid)
            """);

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0236", diagnostic.Id);
        Assert.Equal(
            "out var invalid",
            diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void SourceConstructor_OutVarOverloads_RemainAmbiguous()
    {
        var result = Evaluate("""
            class AmbiguousCtor {
                init(out value int32) {
                    value = 0
                }

                init(out value string) {
                    value = ""
                }

                init(ref value bool) {
                }

                init(in value int64) {
                }
            }

            AmbiguousCtor(out var value)
            value
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0266");
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Id is "GS0125" or "GS0236");
    }

    [Fact]
    public void SourceConstructor_OutLetAmbiguity_DeclaresErrorLocal()
    {
        var result = Evaluate("""
            class AmbiguousLetCtor {
                init(out value int32) {
                    value = 0
                }

                init(out value string) {
                    value = ""
                }
            }

            AmbiguousLetCtor(out let value)
            value
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0125");
    }

    [Fact]
    public void SourceConstructor_OutDiscardAmbiguity_PreservesPrimaryDiagnostic()
    {
        var result = Evaluate("""
            class AmbiguousDiscardCtor {
                init(out value int32) {
                    value = 0
                }

                init(out value string) {
                    value = ""
                }
            }

            AmbiguousDiscardCtor(out _)
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0125");
    }

    [Fact]
    public void SourceConstructor_NoApplicableOutVar_DeclaresErrorLocal()
    {
        var result = Evaluate("""
            class NoApplicableOutCtor {
                init(out value int32, first int32, second int32) {
                    value = first + second
                }

                init(out value string, first string, second string, third string) {
                    value = first + second + third
                }
            }

            NoApplicableOutCtor(out var value, 1)
            value
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0267");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0125");
    }

    [Fact]
    public void SourceConstructor_TypedFilterFailure_DeclaresSiblingInferredOutLocal()
    {
        var result = Evaluate("""
            class TypedSiblingFailureCtor {
                init(out first int32, out second int32) {
                    first = 0
                    second = 0
                }

                init(out first int32, out second string) {
                    first = 0
                    second = ""
                }
            }

            TypedSiblingFailureCtor(out var first, out var second bool)
            first
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0267");
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Id is "GS0102" or "GS0125");
    }

    [Fact]
    public void SourceConstructor_MissingRequiredAfterOutVar_DeclaresLocal()
    {
        var result = Evaluate("""
            class MissingRequiredCtor {
                init(out value int32, other int32) {
                    value = other
                }
            }

            MissingRequiredCtor(out var value)
            value + 1
            """);

        AssertPrimaryWithoutUndefined(result, "GS0144");
    }

    [Fact]
    public void SourceConstructor_TooManyArgumentsAfterOutLet_DeclaresLocal()
    {
        var result = Evaluate("""
            class TooManyCtor {
                init(out value int32) {
                    value = 0
                }
            }

            TooManyCtor(out let value, 1)
            value + 1
            """);

        AssertPrimaryWithoutUndefined(result, "GS0144");
    }

    [Fact]
    public void SourceConstructor_InvalidNamedOrderAfterTypedOut_DeclaresLocal()
    {
        var result = Evaluate("""
            class NamedOrderCtor {
                init(other int32, out value int32) {
                    value = other
                }
            }

            NamedOrderCtor(value: out var value int32, 1)
            value + 1
            """);

        AssertPrimaryWithoutUndefined(result, "GS0244");
    }

    [Fact]
    public void SourceConstructor_DuplicateNamedArgumentWithOutVar_DeclaresErrorLocal()
    {
        var result = Evaluate("""
            class DuplicateNamedCtor {
                init(out value int32, other int32 = 0) {
                    value = other
                }
            }

            DuplicateNamedCtor(value: out var value, value: 1)
            value
            """);

        AssertPrimaryWithoutUndefined(result, "GS0245");
    }

    [Fact]
    public void SourceConstructor_UnknownNamedArgumentAfterOutVar_DeclaresLocal()
    {
        var result = Evaluate("""
            class UnknownNamedCtor {
                init(out value int32, other int32 = 0) {
                    value = other
                }
            }

            UnknownNamedCtor(value: out var value, missing: 1)
            value
            """);

        AssertPrimaryWithoutUndefined(result, "GS0246");
    }

    [Fact]
    public void SourceConstructor_VariadicMismatchAfterOutDiscard_PreservesPrimaryDiagnostic()
    {
        var result = Evaluate("""
            class VariadicMismatchCtor {
                init(out value int32, rest ...int32) {
                    value = 0
                }
            }

            VariadicMismatchCtor(out _, "bad")
            """);

        AssertPrimaryWithoutUndefined(result, "GS0154");
    }

    [Fact]
    public void SourceConstructor_ConversionFailureAfterOutVar_DeclaresLocal()
    {
        var result = Evaluate("""
            class ConversionFailureCtor {
                init(out value int32, other int32) {
                    value = other
                }
            }

            ConversionFailureCtor(out var value, "bad")
            value + 1
            """);

        AssertPrimaryWithoutUndefined(result, "GS0154");
    }

    private static void AssertPrimaryWithoutUndefined(EmittedOracleResult result, string primaryId)
    {
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == primaryId);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id is "GS0125" or "GS0236");
    }

    private static void AssertImportedPrimaryWithoutCascades(
        EmittedOracleResult result,
        string primaryId)
    {
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == primaryId);
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Id is "GS0125" or "GS0159" or "GS0285");
    }

    private static EmittedOracleResult Evaluate(string source) => EmittedOracle.Evaluate(source);

    private static EmittedOracleResult EvaluateFixture(string source) =>
        EmittedOracle.Evaluate(source, new[] { typeof(Issue3464GenericConstructor<>).Assembly.Location });
}

public sealed class Issue3464GenericConstructor<T>
{
    public Issue3464GenericConstructor(out T value)
    {
        value = (T)(object)42;
        Value = value;
    }

    public T Value { get; }
}

public sealed class Issue3464RefConstructor
{
    public Issue3464RefConstructor(ref int value)
    {
    }
}

public sealed class Issue3464Outer
{
    public sealed class Nested
    {
        public Nested(out int value)
        {
            value = 42;
            Value = value;
        }

        public int Value { get; }
    }
}

public sealed class Issue3464AmbiguousConstructor
{
    public Issue3464AmbiguousConstructor(out int value)
    {
        value = 0;
    }

    public Issue3464AmbiguousConstructor(out string value)
    {
        value = string.Empty;
    }
}

public sealed class Issue3464AmbiguousTypedConstructor
{
    public Issue3464AmbiguousTypedConstructor(out int value, string tag = null)
    {
        value = tag?.Length ?? 0;
    }

    public Issue3464AmbiguousTypedConstructor(out int value, Uri tag = null)
    {
        value = tag == null ? 0 : 1;
    }
}

public sealed class Issue3464FailureConstructor
{
    public Issue3464FailureConstructor(int prefix, out int value, int required)
    {
        value = prefix + required;
    }
}
