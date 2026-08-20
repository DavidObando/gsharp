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

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0236");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0130");
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
