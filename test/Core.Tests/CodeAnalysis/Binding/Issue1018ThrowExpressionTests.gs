// <copyright file="Issue1018ThrowExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #1018: `throw` usable as an EXPRESSION (a throw-expression),
/// mirroring C# (`x ?? throw e`, `cond ? a : throw e`, arrow bodies,
/// returned operands, arguments). The throw-expression has the bottom
/// (`never`) type, so the surrounding `??` / conditional takes the
/// sibling operand's type. The existing throw STATEMENT must keep working.
/// These tests cover the parser (a (cref:ThrowExpressionSyntax) is
/// produced in expression position) and the binder (well-typed programs bind
/// cleanly; non-Exception operands are rejected).
open class Issue1018ThrowExpressionTests {
    @Fact
    func NullCoalesceRhs_ParsesAsThrowExpression() {
        const Source = `package Issue1018.Parse

import System

func f(s string?) string {
    return s ?? throw Exception("null")
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let throwExprs = Descendants(tree.Root).OfType[ThrowExpressionSyntax]().ToList()
        Assert.Single(throwExprs)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func TernaryBranch_ParsesAsThrowExpression() {
        const Source = `package Issue1018.Ternary

import System

func f(cond bool, a int32) int32 {
    return cond ? a : throw Exception("nope")
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        Assert.Single(Descendants(tree.Root).OfType[ThrowExpressionSyntax]())
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ThrowStatement_DoesNotParseAsThrowExpression() {
        // Regression: a bare `throw e` at statement start is the throw
        // STATEMENT, not a throw-expression.
        const Source = `package Issue1018.Stmt

import System

func f() {
    throw Exception("boom")
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        Assert.Empty(Descendants(tree.Root).OfType[ThrowExpressionSyntax]())
        Assert.Single(Descendants(tree.Root).OfType[ThrowStatementSyntax]())
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func NullCoalesceThrow_BindsCleanly() {
        const Source = `package Issue1018.BindCoalesce

import System

func f(s string?) string {
    return s ?? throw Exception("null")
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func TernaryThrow_BindsCleanly_TakesSiblingType() {
        const Source = `package Issue1018.BindTernary

import System

func f(cond bool, a int32) int32 {
    return cond ? a : throw Exception("nope")
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func ReturnThrowExpression_BindsCleanly() {
        const Source = `package Issue1018.BindReturn

import System

func f(b bool) string {
    return throw Exception("always")
}
`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func ThrowExpression_NonException_IsRejected() {
        const Source = `package Issue1018.NegBind

func f(s string?) string {
    return s ?? throw 42
}
`
        let diagnostics = EmitDiagnostics(Source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError && d.Message.Contains("System.Exception"))
    }

    @Theory
    @InlineData("int32")
    @InlineData("string")
    @InlineData("void")
    func NeverReturningFunction_ConvertsToAnyFunctionResult(resultName string) {
        let resultType = switch resultName {
            case "int32": TypeSymbol.Int32
            case "string": TypeSymbol.String
            default: TypeSymbol.Void
        }
        let from = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, TypeSymbol.Never)
        let to = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, resultType)
        let conversion = Conversion.Classify(from, to)
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
    }

    @Theory
    @InlineData(typeof(() -> int32))
    @InlineData(typeof(() -> string))
    @InlineData(typeof(() -> void))
    func NeverReturningFunction_ConvertsToAnyClrDelegateResult(delegateType Type) {
        let from = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, TypeSymbol.Never)
        let conversion = Conversion.Classify(from, ImportedTypeSymbol.Get(delegateType))
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
    }

    @Fact
    func OahuServiceFactory_ThrowExpressionInitializer_BindsCleanly() {
        const Source = `package Oahu.Cli.Server.Hosting
import System

interface IAuthService {
}

class ServerHost {
    class ServiceFactories {
        private var _auth () -> IAuthService = () -> throw InvalidOperationException("AuthFactory not configured")
    }
}`
        Assert.Empty(EmitDiagnostics(Source).Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func NonBottomReturnAndParameterMismatches_StayRejected() {
        let noParameters = ImmutableArray[TypeSymbol].Empty
        let wrongReturn = Conversion.Classify(
            FunctionTypeSymbol.Get(noParameters, TypeSymbol.String),
            FunctionTypeSymbol.Get(noParameters, TypeSymbol.Int32)
        )
        let wrongParameter = Conversion.Classify(
            FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](TypeSymbol.String), TypeSymbol.Never),
            FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32), TypeSymbol.String)
        )
        Assert.False(wrongReturn.Exists)
        Assert.False(wrongParameter.Exists)
        const Source = `package Issue2716.Negative

interface IAuthService {
}

class ServiceFactories {
    private var _auth () -> IAuthService = () -> "not an auth service"
}`
        Assert.Contains(EmitDiagnostics(Source), (d Diagnostic) -> d.IsError && d.Id == "GS0155")
    }

    shared {
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree)
        }

        private func EmitDiagnostics(source string) ImmutableArray[Diagnostic] {
            let compilation = Compile(source)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }

        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Descendants(child) {
                    yield descendant
                }
            }
        }
    }
}
