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
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0236");
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
