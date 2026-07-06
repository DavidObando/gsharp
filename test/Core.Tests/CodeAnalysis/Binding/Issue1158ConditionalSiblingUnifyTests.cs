// <copyright file="Issue1158ConditionalSiblingUnifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1158: an <c>if</c>/conditional-expression whose two arms are sibling
/// subtypes sharing a common base (or interface) must unify to that common
/// supertype (best-common-type), and an explicit target type must drive the
/// conversion (C# 9+ target-typed conditional) — matching the switch-expression
/// machinery (#1112/#1151). These tests cover both the <c>if</c>-expression and
/// the ternary <c>?:</c> form, and confirm the existing one-way, numeric and
/// nil behaviors are unchanged.
/// </summary>
public class Issue1158ConditionalSiblingUnifyTests
{
    // Sibling subtypes of a shared base, a base/derived pair, and two classes
    // sharing only an interface (no common non-object base).
    private const string Hierarchy = @"
open class Box { }
class Co64Box : Box { }
class StcoBox : Box { }
open class Animal { }
class Dog : Animal { }
interface IShape { }
class Sq : IShape { }
class Ci : IShape { }
class Unrelated { }
";

    [Fact]
    public void ReproF_ReturnIfExpression_SiblingArms_ReturnTypeBox_NoDiagnostics()
    {
        // Issue repro F: both arms are siblings of Box; the declared return type
        // Box is the target the arms unify to.
        var diagnostics = Bind(Hierarchy + @"
func F(b bool, x Co64Box, y StcoBox) Box {
    return if b { x } else { y }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ReproG_LetTypedBox_IfExpression_SiblingArms_NoDiagnostics()
    {
        // Issue repro G: an explicitly-typed local Box supplies the target type.
        var diagnostics = Bind(Hierarchy + @"
func G(b bool, x Co64Box, y StcoBox) {
    let r Box = if b { x } else { y }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Ternary_SiblingArms_ReturnTypeBox_NoDiagnostics()
    {
        var diagnostics = Bind(Hierarchy + @"
func F(b bool, x Co64Box, y StcoBox) Box {
    return b ? x : y
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Ternary_SiblingArms_LetTypedBox_NoDiagnostics()
    {
        var diagnostics = Bind(Hierarchy + @"
func G(b bool, x Co64Box, y StcoBox) {
    let r Box = b ? x : y
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NoTarget_IfExpression_SiblingArms_InfersBox()
    {
        // No declared target: the best-common-type (LUB) fallback unifies the
        // two siblings to their shared base Box.
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let x = Co64Box()
let y = StcoBox()
let r = if b { x } else { y }
");

        Assert.Empty(scope.Diagnostics);
        Assert.Equal("Box", scope.Variables.Single(v => v.Name == "r").Type.Name);
    }

    [Fact]
    public void NoTarget_Ternary_SiblingArms_InfersBox()
    {
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let x = Co64Box()
let y = StcoBox()
let r = b ? x : y
");

        Assert.Empty(scope.Diagnostics);
        Assert.Equal("Box", scope.Variables.Single(v => v.Name == "r").Type.Name);
    }

    [Fact]
    public void NoTarget_IfExpression_CommonInterfaceArms_InfersIShape()
    {
        // Sq and Ci share only the interface IShape (no common non-object base);
        // the LUB enumerates interfaces and unifies to IShape.
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let x = Sq()
let y = Ci()
let r = if b { x } else { y }
");

        Assert.Empty(scope.Diagnostics);
        Assert.Equal("IShape", scope.Variables.Single(v => v.Name == "r").Type.Name);
    }

    [Fact]
    public void NoTarget_Ternary_CommonInterfaceArms_InfersIShape()
    {
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let x = Sq()
let y = Ci()
let r = b ? x : y
");

        Assert.Empty(scope.Diagnostics);
        Assert.Equal("IShape", scope.Variables.Single(v => v.Name == "r").Type.Name);
    }

    [Fact]
    public void TargetTyped_LetIShape_CommonInterfaceArms_NoDiagnostics()
    {
        var diagnostics = Bind(Hierarchy + @"
func H(b bool, x Sq, y Ci) {
    let r IShape = if b { x } else { y }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void BaseDerived_IfExpression_TargetAnimal_NoDiagnostics()
    {
        // One arm IS the base (Animal); the existing one-way implicit path keeps
        // working unchanged.
        var diagnostics = Bind(Hierarchy + @"
func B(b bool, d Dog, a Animal) Animal {
    return if b { d } else { a }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void BaseDerived_NoTarget_InfersAnimal()
    {
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let d = Dog()
let a = Animal()
let r = if b { d } else { a }
");

        Assert.Empty(scope.Diagnostics);
        Assert.Equal("Animal", scope.Variables.Single(v => v.Name == "r").Type.Name);
    }

    [Fact]
    public void Numeric_IfExpression_Int32AndInt64_StillUnifiesToInt64()
    {
        // Guard: ADR-0037 numeric tie-break behavior is unchanged — an int32 and
        // an int64 arm unify to int64 (issue #1150's surface is untouched).
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let i32v int32 = 5
let i64v int64 = 5
let r = if b { i32v } else { i64v }
");

        Assert.Empty(scope.Diagnostics);
        Assert.Equal(TypeSymbol.Int64, scope.Variables.Single(v => v.Name == "r").Type);
    }

    [Fact]
    public void Numeric_Ternary_Int32AndInt64_StillUnifiesToInt64()
    {
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let i32v int32 = 5
let i64v int64 = 5
let r = b ? i32v : i64v
");

        Assert.Empty(scope.Diagnostics);
        Assert.Equal(TypeSymbol.Int64, scope.Variables.Single(v => v.Name == "r").Type);
    }

    [Fact]
    public void Unrelated_NoTarget_IfExpression_StillReportsGS0263()
    {
        // Two unrelated user classes share only object; with NO target type the
        // best-common-type (which deliberately excludes object) yields none, so
        // GS0263 still fires.
        var diagnostics = Bind(Hierarchy + @"
func U(b bool, x Box, y Unrelated) {
    let r = if b { x } else { y }
}
");

        Assert.Contains(diagnostics, d => d.Id == "GS0263");
    }

    [Fact]
    public void Unrelated_ObjectTarget_IfExpression_NoDiagnostics()
    {
        // string and int32 share only object. With NO target the conditional is
        // GS0263, but an explicit `object` target drives both arms' implicit
        // conversion to object (target-typing), so it binds cleanly.
        var diagnostics = Bind(Hierarchy + @"
func O(b bool, s string, n int32) {
    let r object = if b { s } else { n }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Unrelated_ObjectTarget_NoTarget_StillReportsGS0263()
    {
        // The same string/int32 pair WITHOUT a target still reports GS0263.
        var diagnostics = Bind(Hierarchy + @"
func O(b bool, s string, n int32) {
    let r = if b { s } else { n }
}
");

        Assert.Contains(diagnostics, d => d.Id == "GS0263");
    }

    [Fact]
    public void Unrelated_ObjectTarget_Ternary_NoDiagnostics()
    {
        var diagnostics = Bind(Hierarchy + @"
func O(b bool, s string, n int32) {
    let r object = b ? s : n
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NilArm_NullableReferenceArm_IfExpression_UnifiesToNullable()
    {
        // A nullable-reference arm (`string?`) unified with a `nil` arm stays
        // `string?` — unchanged from the existing nil/null handling.
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let s string? = ""hi""
let r = if b { s } else { nil }
");

        Assert.Empty(scope.Diagnostics);
        var nullable = Assert.IsType<NullableTypeSymbol>(scope.Variables.Single(v => v.Name == "r").Type);
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType);
    }

    [Fact]
    public void NilArm_NullableReferenceArm_Ternary_UnifiesToNullable()
    {
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let s string? = ""hi""
let r = b ? s : nil
");

        Assert.Empty(scope.Diagnostics);
        var nullable = Assert.IsType<NullableTypeSymbol>(scope.Variables.Single(v => v.Name == "r").Type);
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType);
    }

    [Fact]
    public void NoTarget_IfExpression_NullableCommonInterfaceArms_InfersNullableIShape()
    {
        // Issue #2202: both arms are NULLABLE-wrapped siblings (Sq?/Ci?) that
        // share only the interface IShape. Before the fix, EnumerateSupertypeCandidates
        // never unwrapped the NullableTypeSymbol arms, so the base/interface walk
        // never found IShape and the conditional reported GS0263. The common type
        // must be computed on the unwrapped types (Sq/Ci -> IShape) and then
        // re-wrapped nullable since both arms were nullable.
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let x Sq? = Sq()
let y Ci? = Ci()
let r = if b { x } else { y }
");

        Assert.Empty(scope.Diagnostics);
        var nullable = Assert.IsType<NullableTypeSymbol>(scope.Variables.Single(v => v.Name == "r").Type);
        Assert.Equal("IShape", nullable.UnderlyingType.Name);
    }

    [Fact]
    public void NoTarget_Ternary_NullableCommonInterfaceArms_InfersNullableIShape()
    {
        var scope = BindGlobalScope(Hierarchy + @"
let b = true
let x Sq? = Sq()
let y Ci? = Ci()
let r = b ? x : y
");

        Assert.Empty(scope.Diagnostics);
        var nullable = Assert.IsType<NullableTypeSymbol>(scope.Variables.Single(v => v.Name == "r").Type);
        Assert.Equal("IShape", nullable.UnderlyingType.Name);
    }

    [Fact]
    public void TargetTyped_LetNullableIShape_NullableCommonInterfaceArms_NoDiagnostics()
    {
        var diagnostics = Bind(Hierarchy + @"
func H(b bool, x Sq?, y Ci?) {
    let r IShape? = if b { x } else { y }
}
");

        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }

    private static BoundGlobalScope BindGlobalScope(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
