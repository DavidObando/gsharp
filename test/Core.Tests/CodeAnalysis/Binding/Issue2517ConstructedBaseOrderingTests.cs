// <copyright file="Issue2517ConstructedBaseOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Binding regressions for issue #2517's early generic construction ordering.</summary>
public sealed class Issue2517ConstructedBaseOrderingTests
{
    [Fact]
    public void EarlyReturnSignature_BeforeGenericBaseDefinition_PreservesOverrideAndInheritedMembers()
    {
        var early = Parse(
            """
            package Other
            import P
            class Early2517 {
                func Get() Middle2517[Entry2517,Entry2517]? -> default(Middle2517[Entry2517,Entry2517]?)
            }
            """);
        var derived = Parse(
            """
            package P.Audio
            import P
            open class Derived2517 : Middle2517[Entry2517,Entry2517] {
                protected open override prop Size int32 -> 100
                func Read() int32 -> Size + Inherited()
            }
            """);
        var entry = Parse(
            """
            package P
            class Entry2517 { }
            """);
        var middle = Parse(
            """
            package P
            open class Middle2517[TInput,TOutput] : Base2517[TInput] { }
            """);
        var baseType = Parse(
            """
            package P
            open class Base2517[T] {
                protected open prop Size int32 { get; }
                protected func Inherited() int32 -> 1
            }
            """);

        var result = new Compilation(early, derived, entry, middle, baseType)
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void MultiLevelGenericBase_WithExplicitBaseConstructor_IsTreeOrderIndependent(bool reverse)
    {
        var early = Parse(
            """
            package Other2517
            import Layers2517
            class EarlyCtor2517 {
                var Value Layer2517[int32]?
            }
            """);
        var derived = Parse(
            """
            package Layers2517
            class Final2517 : Layer2517[int32] {
                init() : base(41) { }
                override func Read() int32 -> 42
            }
            """);
        var layers = Parse(
            """
            package Layers2517
            open class Root2517[T] {
                init(value T) { }
                open func Read() int32 -> 1
            }
            open class Layer2517[T] : Root2517[T] {
                init(value T) : base(value) { }
            }
            """);

        var trees = reverse
            ? new[] { layers, derived, early }
            : new[] { early, derived, layers };
        var result = new Compilation(trees)
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
    }

    private static SyntaxTree Parse(string source)
        => SyntaxTree.Parse(SourceText.From(source));
}
