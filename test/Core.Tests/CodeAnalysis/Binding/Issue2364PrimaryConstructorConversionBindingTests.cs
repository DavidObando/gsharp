// <copyright file="Issue2364PrimaryConstructorConversionBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2364: the fixed-arity/non-optional argument-binding loop in
/// <c>OverloadResolver.BindConstructorCallExpressionCore</c> validated that an
/// argument's conversion to its primary-constructor parameter type was
/// implicit, but never bound it — leaving the raw, unconverted argument in the
/// bound tree. The emitter then had nothing to compensate with, producing
/// unverifiable IL despite a clean compile.
///
/// These tests inspect the BOUND TREE directly (not just diagnostics, and not
/// via emitted IL) to prove the fix actually threads a real conversion node
/// through every primary-constructor argument that needs one, while leaving
/// already-correct sibling paths (explicit <c>init(...)</c> constructors, the
/// optional-parameter primary-constructor path, and ordinary method/function
/// calls) unaffected.
/// </summary>
public class Issue2364PrimaryConstructorConversionBindingTests
{
    [Fact]
    public void ExactArityPrimaryCtor_IntLiteralIntoNullableParam_BindsConversionExpression()
    {
        var source = @"
class Plain(SampleRate int32?, BitRate int32?) {}
let p = Plain(22050, 32)
0
";
        var argument = GetFirstConstructorCallArgument(source, "Plain");
        Assert.IsType<BoundConversionExpression>(argument);
        Assert.IsType<NullableTypeSymbol>(argument.Type);
    }

    [Fact]
    public void ExactArityPrimaryCtor_IntLiteralIntoWideningParams_BindsConversionExpressions()
    {
        var source = @"
class Wide(BigNum int64, Frac double) {}
let w = Wide(22050, 32)
0
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);

        var call = FindConstructorCall(compilation, "Wide");
        Assert.NotNull(call);
        Assert.Equal(2, call.Arguments.Length);
        Assert.IsType<BoundConversionExpression>(call.Arguments[0]);
        Assert.Equal(TypeSymbol.Int64, call.Arguments[0].Type);
        Assert.IsType<BoundConversionExpression>(call.Arguments[1]);
        Assert.Equal(TypeSymbol.Float64, call.Arguments[1].Type);
    }

    [Fact]
    public void ExactArityPrimaryCtor_DataClass_BindsConversionExpression()
    {
        var source = @"
open data class AudioQuality(SampleRate int32?, BitRate int32?) {}
let q = AudioQuality(22050, 32)
0
";
        var argument = GetFirstConstructorCallArgument(source, "AudioQuality");
        Assert.IsType<BoundConversionExpression>(argument);
        Assert.IsType<NullableTypeSymbol>(argument.Type);
    }

    [Fact]
    public void ExactArityPrimaryCtor_NonLiteralVariableArgument_BindsConversionExpression()
    {
        var source = @"
class Plain(SampleRate int32?, BitRate int32?) {}
let a = 22050
let b = 32
let p = Plain(a, b)
0
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);

        var call = FindConstructorCall(compilation, "Plain");
        Assert.NotNull(call);
        Assert.IsType<BoundConversionExpression>(call.Arguments[0]);
        Assert.IsType<NullableTypeSymbol>(call.Arguments[0].Type);
        Assert.IsType<BoundConversionExpression>(call.Arguments[1]);
        Assert.IsType<NullableTypeSymbol>(call.Arguments[1].Type);
    }

    [Fact]
    public void ExactArityPrimaryCtor_UserDefinedImplicitConversion_BindsConversion()
    {
        var source = @"
struct Meters {
    var V int32
    func operator implicit (v int32) Meters {
        return Meters{V: v}
    }
}
class Holder(Distance Meters) {}
let h = Holder(5)
0
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);

        var call = FindConstructorCall(compilation, "Holder");
        Assert.NotNull(call);
        // A user-defined conversion argument does not have to surface as a
        // BoundConversionExpression wrapper node (the user-defined-conversion
        // call itself is the converted value), but it MUST no longer be the
        // raw int32 literal — the argument's static type must match the
        // parameter type (Meters), proving some conversion step ran.
        Assert.NotEqual(TypeSymbol.Int32, call.Arguments[0].Type);
    }

    // --- Control cases: sibling paths that were already correct and must
    // remain unaffected by the fix. ---

    [Fact]
    public void Control_ExplicitInitConstructor_AlreadyBindsConversion()
    {
        var source = @"
class Plain {
    var SampleRate int32?
    var BitRate int32?
    init(sampleRate int32?, bitRate int32?) {
        this.SampleRate = sampleRate
        this.BitRate = bitRate
    }
}
let p = Plain(22050, 32)
0
";
        var argument = GetFirstConstructorCallArgument(source, "Plain");
        Assert.IsType<BoundConversionExpression>(argument);
        Assert.IsType<NullableTypeSymbol>(argument.Type);
    }

    [Fact]
    public void Control_OptionalParameterPrimaryCtor_AlreadyBindsConversion()
    {
        var source = @"
class Plain(SampleRate int32?, BitRate int32? = nil) {}
let p = Plain(22050, 32)
0
";
        var argument = GetFirstConstructorCallArgument(source, "Plain");
        Assert.IsType<BoundConversionExpression>(argument);
        Assert.IsType<NullableTypeSymbol>(argument.Type);
    }

    [Fact]
    public void Control_RegularFunctionCall_AlreadyBindsConversion()
    {
        var source = @"
func Foo(x int32?) {}
Foo(5)
0
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);

        var call = compilation.GlobalScope.Statements
            .OfType<BoundExpressionStatement>()
            .Select(s => s.Expression)
            .OfType<BoundCallExpression>()
            .FirstOrDefault(c => c.Function.Name == "Foo");
        Assert.NotNull(call);
        Assert.IsType<BoundConversionExpression>(call.Arguments[0]);
        Assert.IsType<NullableTypeSymbol>(call.Arguments[0].Type);
    }

    private static BoundExpression GetFirstConstructorCallArgument(string source, string typeName)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);

        var call = FindConstructorCall(compilation, typeName);
        Assert.NotNull(call);
        Assert.True(call.Arguments.Length > 0);
        return call.Arguments[0];
    }

    private static BoundConstructorCallExpression FindConstructorCall(Compilation compilation, string typeName)
    {
        return compilation.GlobalScope.Statements
            .OfType<BoundVariableDeclaration>()
            .Select(s => s.Initializer)
            .OfType<BoundConstructorCallExpression>()
            .FirstOrDefault(c => c.StructType.Name == typeName);
    }

}
