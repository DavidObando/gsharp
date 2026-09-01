// <copyright file="Issue3258BoundSyntaxDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #3258: source syntax must survive direct-call
/// binding and bound-tree rewriting so diagnostics can use it as a precise
/// fallback when a synthesized interpolation hole has no syntax carrier.
/// </summary>
public class Issue3258BoundSyntaxDiagnosticTests
{
    private sealed class HoleSyntaxStrippingRewriter : BoundTreeRewriter
    {
        protected override BoundExpression RewriteInterpolatedStringExpression(BoundInterpolatedStringExpression node)
        {
            var parts = ImmutableArray.CreateBuilder<BoundInterpolatedStringPart>(node.Parts.Length);
            foreach (var part in node.Parts)
            {
                parts.Add(
                    part.IsLiteral
                        ? part
                        : BoundInterpolatedStringPart.FromHole(part.Value, part.Alignment, part.Format));
            }

            return new BoundInterpolatedStringExpression(node.Syntax, parts.MoveToImmutable(), node.Handler);
        }
    }

    private sealed class ForceCallCloneRewriter : BoundTreeRewriter
    {
        public new BoundExpression RewriteExpression(BoundExpression node) => base.RewriteExpression(node);

        protected override BoundExpression RewriteLiteralExpression(BoundLiteralExpression node)
            => new BoundLiteralExpression(node.Syntax, node.Value);
    }

    [Fact]
    public void SynthesizedHoleWithoutSyntax_ReportsGS0519AtCallSpan()
    {
        const string Source = """
            ref struct Token {
                var value int32
            }

            func MakeToken() Token {
                return Token{value: 42}
            }

            func Main() {
                Console.WriteLine("token=${MakeToken()}")
            }
            """;

        var tree = SyntaxTree.Parse(SourceText.From(Source, "issue3258.gs"));
        var compilation = new Compilation(tree);
        Assert.Empty(tree.Diagnostics);
        Assert.Empty(compilation.GlobalScope.Diagnostics);
        Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, diagnostic => diagnostic.IsError);

        var program = StripHoleSyntax(compilation.BoundProgram);
        var lowered = InterpolatedStringHandlerLowerer.Lower(program, ReferenceResolver.Default());
        var diagnostic = Assert.Single(lowered.Diagnostics, diagnostic => diagnostic.Id == "GS0519");
        var location = diagnostic.Location;

        Assert.Equal(
            (StartLine: 10, StartColumn: 32, EndLine: 10, EndColumn: 43),
            (
                StartLine: location.StartLine + 1,
                StartColumn: location.StartCharacter + 1,
                EndLine: location.EndLine + 1,
                EndColumn: location.EndCharacter + 1));
        Assert.Equal("MakeToken()", location.Text.ToString(location.Span));
    }

    [Fact]
    public void RewriteCallExpression_PreservesSourceSyntax()
    {
        var tree = SyntaxTree.Parse("MakeToken(1)\n");
        Assert.Empty(tree.Diagnostics);
        var statement = Assert.IsType<GlobalStatementSyntax>(Assert.Single(tree.Root.Members)).Statement;
        var expression = Assert.IsType<ExpressionStatementSyntax>(statement).Expression;
        var syntax = Assert.IsType<CallExpressionSyntax>(expression);
        var argumentSyntax = Assert.Single(syntax.Arguments);
        var function = new FunctionSymbol("MakeToken", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int32);
        var call = new BoundCallExpression(
            syntax,
            function,
            ImmutableArray.Create<BoundExpression>(new BoundLiteralExpression(argumentSyntax, 1)));

        var rewritten = Assert.IsType<BoundCallExpression>(
            new ForceCallCloneRewriter().RewriteExpression(call));

        Assert.NotSame(call, rewritten);
        Assert.Same(syntax, rewritten.Syntax);
    }

    private static BoundProgram StripHoleSyntax(BoundProgram program)
    {
        var rewriter = new HoleSyntaxStrippingRewriter();
        var functions = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        foreach (var pair in program.Functions)
        {
            functions.Add(pair.Key, (BoundBlockStatement)rewriter.RewriteStatement(pair.Value));
        }

        return new BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            program.Diagnostics,
            functions.ToImmutable(),
            program.EntryPoint,
            (BoundBlockStatement)rewriter.RewriteStatement(program.Statement),
            program.Structs,
            program.Interfaces,
            program.Enums,
            program.Globals,
            program.Delegates)
        {
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
            ModuleAttributes = program.ModuleAttributes,
        };
    }
}
