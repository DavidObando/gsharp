// <copyright file="Issue2621ImportedGenericConstructorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2621ImportedGenericConstructorTests
{
    [Fact]
    public void OahuCli_ListOfNestedGeneric_WithCapacity_Binds()
    {
        const string source = """
            package Oahu.Cli.Commands
            import System.Collections.Generic

            func BuildRows(capacity int32) List[IReadOnlyDictionary[string, object?]] {
                return List[IReadOnlyDictionary[string, object?]](capacity)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedGenericConstructor_MismatchedOverload_IsNotMissingFunction()
    {
        const string source = """
            package Oahu.Cli.Commands
            import System.Collections.Generic

            func BuildRows() {
                let rows = List[IReadOnlyDictionary[string, object?]]("bad")
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0267");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS0130");
    }

    [Fact]
    public void ImportedGenericConstructor_ArgumentError_DoesNotCascadeToMissingFunction()
    {
        const string source = """
            package Oahu.Cli.Commands
            import System.Collections.Generic

            func BuildRows() {
                let rows = List[IReadOnlyDictionary[string, object?]](missing.Count)
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0157");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id is "GS0130" or "GS0267");
    }

    [Fact]
    public void ImportedGenericValueType_ConversionCallFromObject_Unboxes()
    {
        // Issue #3684 (family F8): `ImmutableArray[int32](o)` is the G#
        // spelling of a C# `(ImmutableArray<int>)o` CAST, not a construction —
        // there is no single-`object` `.ctor`. The constructor-overload
        // fallback offered a checked REFERENCE conversion only, which a value
        // type can never satisfy, so the whole shape reported GS0267.
        const string source = """
            package Demo
            import System.Collections.Immutable

            func Take(o object) ImmutableArray[int32] {
                return ImmutableArray[int32](o)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedGenericValueType_ConversionCallFromUnrelatedValue_StillReportsNoOverload()
    {
        // The unboxing fallback must not swallow a genuinely impossible
        // conversion: an `int32` source is not a box, so there is nothing to
        // unbox and GS0267 still stands.
        const string source = """
            package Demo
            import System.Collections.Immutable

            func Take(n int32) {
                let taken = ImmutableArray[int32](n)
            }
            """;

        Assert.Contains(Bind(source), diagnostic => diagnostic.Id == "GS0267");
    }

    [Fact]
    public void ImportedGenericDelegate_ConversionCallFromLambda_Binds()
    {
        // Issue #3684 (family F8), third shape: `Func[int32, int32](lambda)` is
        // the G# form of a C# `(Func<int, int>)(e => …)` cast. The CLR delegate
        // `.ctor` takes `(object, IntPtr)`, so the one-argument call never
        // resolved and the cast reported GS0267.
        const string source = """
            package Demo
            import System

            func Wrap() Func[int32, int32] {
                return Func[int32, int32](((e int32) -> e + 1))
            }
            """;

        Assert.Empty(Bind(source));
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        return EmittedOracle.Evaluate(source).Diagnostics;
    }
}
