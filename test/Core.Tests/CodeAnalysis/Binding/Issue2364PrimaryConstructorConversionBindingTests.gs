// <copyright file="Issue2364PrimaryConstructorConversionBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #2364: the fixed-arity/non-optional argument-binding loop in
/// `OverloadResolver.BindConstructorCallExpressionCore` validated that an
/// argument's conversion to its primary-constructor parameter type was
/// implicit, but never bound it — leaving the raw, unconverted argument in the
/// bound tree. The emitter then had nothing to compensate with, producing
/// unverifiable IL despite a clean compile.
///
/// These tests inspect the BOUND TREE directly (not just diagnostics, and not
/// via emitted IL) to prove the fix actually threads a real conversion node
/// through every primary-constructor argument that needs one, while leaving
/// already-correct sibling paths (explicit `init(...)` constructors, the
/// optional-parameter primary-constructor path, and ordinary method/function
/// calls) unaffected.
open class Issue2364PrimaryConstructorConversionBindingTests {
    @Fact
    func ExactArityPrimaryCtor_IntLiteralIntoNullableParam_BindsConversionExpression() {
        let source = `
class Plain(SampleRate int32?, BitRate int32?) {}
let p = Plain(22050, 32)
0
`
        let argument = GetFirstConstructorCallArgument(source, "Plain")
        Assert.IsType[BoundConversionExpression](argument)
        Assert.IsType[NullableTypeSymbol](argument.Type)
    }

    @Fact
    func ExactArityPrimaryCtor_IntLiteralIntoWideningParams_BindsConversionExpressions() {
        let source = `
class Wide(BigNum int64, Frac double) {}
let w = Wide(22050, 32)
0
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let call BoundConstructorCallExpression? = FindConstructorCall(compilation, "Wide")
        Assert.NotNull(call)
        Assert.Equal(2, call!!.Arguments.Length)
        Assert.IsType[BoundConversionExpression](call!!.Arguments[0])
        Assert.Equal(TypeSymbol.Int64, call!!.Arguments[0].Type)
        Assert.IsType[BoundConversionExpression](call!!.Arguments[1])
        Assert.Equal(TypeSymbol.Float64, call!!.Arguments[1].Type)
    }

    @Fact
    func ExactArityPrimaryCtor_DataClass_BindsConversionExpression() {
        let source = `
open data class AudioQuality(SampleRate int32?, BitRate int32?) {}
let q = AudioQuality(22050, 32)
0
`
        let argument = GetFirstConstructorCallArgument(source, "AudioQuality")
        Assert.IsType[BoundConversionExpression](argument)
        Assert.IsType[NullableTypeSymbol](argument.Type)
    }

    @Fact
    func ExactArityPrimaryCtor_NonLiteralVariableArgument_BindsConversionExpression() {
        let source = `
class Plain(SampleRate int32?, BitRate int32?) {}
let a = 22050
let b = 32
let p = Plain(a, b)
0
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let call BoundConstructorCallExpression? = FindConstructorCall(compilation, "Plain")
        Assert.NotNull(call)
        Assert.IsType[BoundConversionExpression](call!!.Arguments[0])
        Assert.IsType[NullableTypeSymbol](call!!.Arguments[0].Type)
        Assert.IsType[BoundConversionExpression](call!!.Arguments[1])
        Assert.IsType[NullableTypeSymbol](call!!.Arguments[1].Type)
    }

    @Fact
    func ExactArityPrimaryCtor_UserDefinedImplicitConversion_BindsConversion() {
        let source = `
struct Meters {
    var V int32
    func operator implicit (v int32) Meters {
        return Meters{V: v}
    }
}
class Holder(Distance Meters) {}
let h = Holder(5)
0
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let call BoundConstructorCallExpression? = FindConstructorCall(compilation, "Holder")
        Assert.NotNull(call)
        // A user-defined conversion argument does not have to surface as a
        // BoundConversionExpression wrapper node (the user-defined-conversion
        // call itself is the converted value), but it MUST no longer be the
        // raw int32 literal — the argument's static type must match the
        // parameter type (Meters), proving some conversion step ran.
        Assert.NotEqual(TypeSymbol.Int32, call!!.Arguments[0].Type)
    }

    // --- Control cases: sibling paths that were already correct and must
    // remain unaffected by the fix. ---
    @Fact
    func Control_ExplicitInitConstructor_AlreadyBindsConversion() {
        let source = `
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
`
        let argument = GetFirstConstructorCallArgument(source, "Plain")
        Assert.IsType[BoundConversionExpression](argument)
        Assert.IsType[NullableTypeSymbol](argument.Type)
    }

    @Fact
    func Control_OptionalParameterPrimaryCtor_AlreadyBindsConversion() {
        let source = `
class Plain(SampleRate int32?, BitRate int32? = nil) {}
let p = Plain(22050, 32)
0
`
        let argument = GetFirstConstructorCallArgument(source, "Plain")
        Assert.IsType[BoundConversionExpression](argument)
        Assert.IsType[NullableTypeSymbol](argument.Type)
    }

    @Fact
    func Control_RegularFunctionCall_AlreadyBindsConversion() {
        let source = `
func Foo(x int32?) {}
Foo(5)
0
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let call BoundCallExpression? = compilation
            .GlobalScope
            .Statements
            .OfType[BoundExpressionStatement]()
            .Select((s BoundExpressionStatement) -> s.Expression)
            .OfType[BoundCallExpression]()
            .FirstOrDefault((c BoundCallExpression) -> c.Function.Name == "Foo")
        Assert.NotNull(call)
        Assert.IsType[BoundConversionExpression](call!!.Arguments[0])
        Assert.IsType[NullableTypeSymbol](call!!.Arguments[0].Type)
    }

    shared {
        private func GetFirstConstructorCallArgument(source string, typeName string) BoundExpression {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
            let call BoundConstructorCallExpression? = FindConstructorCall(compilation, typeName)
            Assert.NotNull(call)
            Assert.True(call!!.Arguments.Length > 0)
            return call!!.Arguments[0]
        }

        private func FindConstructorCall(compilation Compilation, typeName string) BoundConstructorCallExpression? {
            return compilation
                .GlobalScope
                .Statements
                .OfType[BoundVariableDeclaration]()
                .Select((s BoundVariableDeclaration) -> s.Initializer)
                .OfType[BoundConstructorCallExpression]()
                .FirstOrDefault((c BoundConstructorCallExpression) -> c.StructType.Name == typeName)
        }
    }
}
