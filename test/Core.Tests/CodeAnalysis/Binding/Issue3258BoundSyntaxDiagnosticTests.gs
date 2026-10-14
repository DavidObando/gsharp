// <copyright file="Issue3258BoundSyntaxDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import Xunit

/// Regression tests for issue #3258: source syntax must survive direct-call
/// binding and bound-tree rewriting so diagnostics can use it as a precise
/// fallback when a synthesized interpolation hole has no syntax carrier.
open class Issue3258BoundSyntaxDiagnosticTests {
    private class HoleSyntaxStrippingRewriter : BoundTreeRewriter {
        protected override func RewriteInterpolatedStringExpression(
            node BoundInterpolatedStringExpression
        ) BoundExpression {
            let parts = ImmutableArray.CreateBuilder[BoundInterpolatedStringPart](node.Parts.Length)
            for part in node.Parts {
                parts.Add(
                    if part.IsLiteral {
                        part
                    } else {
                        BoundInterpolatedStringPart.FromHole(part.Value!!, part.Alignment, part.Format)
                    }
                )
            }
            return BoundInterpolatedStringExpression(node.Syntax, parts.MoveToImmutable(), node.Handler)
        }
    }

    private class ForceCallCloneRewriter : BoundTreeRewriter {
        func RewriteExpression(node BoundExpression) BoundExpression -> base.RewriteExpression(node)

        protected override func RewriteLiteralExpression(
            node BoundLiteralExpression
        ) BoundExpression -> BoundLiteralExpression(node.Syntax, node.Value)
    }

    @Fact
    func SynthesizedHoleWithoutSyntax_ReportsGS0519AtCallSpan() {
        const Source = `ref struct Token {
    var value int32
}

func MakeToken() Token {
    return Token{value: 42}
}

func Main() {
    Console.WriteLine("token=${MakeToken()}")
}`
        let tree = SyntaxTree.Parse(SourceText.From(Source, "issue3258.gs"))
        let compilation = Compilation(tree)
        Assert.Empty(tree.Diagnostics)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        let program = StripHoleSyntax(compilation.BoundProgram)
        let lowered = InterpolatedStringHandlerLowerer.Lower(program, ReferenceResolver.Default())
        let diagnostic = Assert.Single(lowered.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0519")
        var location = diagnostic.Location
        Assert.Equal(
            (StartLine: 10, StartColumn: 32, EndLine: 10, EndColumn: 43),
            (
                StartLine: location.StartLine + 1,
                StartColumn: location.StartCharacter + 1,
                EndLine: location.EndLine + 1,
                EndColumn: location.EndCharacter + 1
            )
        )
        Assert.Equal("MakeToken()", location.Text!!.ToString(location.Span))
    }

    @Fact
    func RewriteCallExpression_PreservesSourceSyntax() {
        let tree = SyntaxTree.Parse("MakeToken(1)\n")
        Assert.Empty(tree.Diagnostics)
        let statement = Assert.IsType[GlobalStatementSyntax](Assert.Single(tree.Root.Members)).Statement
        let expression = Assert.IsType[ExpressionStatementSyntax](statement).Expression
        let syntax = Assert.IsType[CallExpressionSyntax](expression)
        let argumentSyntax = Assert.Single(syntax.Arguments)
        let function = FunctionSymbol("MakeToken", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let call = BoundCallExpression(
            syntax,
            function,
            ImmutableArray.Create[BoundExpression](BoundLiteralExpression(argumentSyntax, 1))
        )
        let rewritten = Assert.IsType[BoundCallExpression](ForceCallCloneRewriter().RewriteExpression(call))
        Assert.NotSame(call, rewritten)
        Assert.Same(syntax, rewritten.Syntax)
    }

    shared {
        private func StripHoleSyntax(program BoundProgram) BoundProgram {
            let rewriter = HoleSyntaxStrippingRewriter()
            let functions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
            for pair in program.Functions {
                functions.Add(pair.Key, cast[BoundBlockStatement](rewriter.RewriteStatement(pair.Value)))
            }
            return BoundProgram(
                program.EntryPointPackage,
                program.Packages,
                program.Diagnostics,
                functions.ToImmutable(),
                program.EntryPoint,
                cast[BoundBlockStatement](rewriter.RewriteStatement(program.Statement)),
                program.Structs,
                program.Interfaces,
                program.Enums,
                program.Globals,
                program.Delegates
            ){
                Imports = program.Imports,
                FriendAssemblies = program.FriendAssemblies,
                AssemblyAttributes = program.AssemblyAttributes,
                ModuleAttributes = program.ModuleAttributes
            }
        }
    }
}
