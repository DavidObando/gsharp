// <copyright file="Issue1018ThrowExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1018: <c>throw</c> usable as an EXPRESSION (a throw-expression),
/// mirroring C# (<c>x ?? throw e</c>, <c>cond ? a : throw e</c>, arrow bodies,
/// returned operands, arguments). The throw-expression has the bottom
/// (<c>never</c>) type, so the surrounding <c>??</c> / conditional takes the
/// sibling operand's type. The existing throw STATEMENT must keep working.
/// These tests cover the parser (a <see cref="ThrowExpressionSyntax"/> is
/// produced in expression position) and the binder (well-typed programs bind
/// cleanly; non-Exception operands are rejected).
/// </summary>
public class Issue1018ThrowExpressionTests
{
    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree);
    }

    private static System.Collections.Immutable.ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> EmitDiagnostics(string source)
    {
        var compilation = Compile(source);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }

    [Fact]
    public void NullCoalesceRhs_ParsesAsThrowExpression()
    {
        const string Source = @"package Issue1018.Parse

import System

func f(s string?) string {
    return s ?? throw Exception(""null"")
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));

        var throwExprs = Descendants(tree.Root)
            .OfType<ThrowExpressionSyntax>()
            .ToList();

        Assert.Single(throwExprs);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void TernaryBranch_ParsesAsThrowExpression()
    {
        const string Source = @"package Issue1018.Ternary

import System

func f(cond bool, a int32) int32 {
    return cond ? a : throw Exception(""nope"")
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));

        Assert.Single(Descendants(tree.Root).OfType<ThrowExpressionSyntax>());
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ThrowStatement_DoesNotParseAsThrowExpression()
    {
        // Regression: a bare `throw e` at statement start is the throw
        // STATEMENT, not a throw-expression.
        const string Source = @"package Issue1018.Stmt

import System

func f() {
    throw Exception(""boom"")
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));

        Assert.Empty(Descendants(tree.Root).OfType<ThrowExpressionSyntax>());
        Assert.Single(Descendants(tree.Root).OfType<ThrowStatementSyntax>());
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void NullCoalesceThrow_BindsCleanly()
    {
        const string Source = @"package Issue1018.BindCoalesce

import System

func f(s string?) string {
    return s ?? throw Exception(""null"")
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void TernaryThrow_BindsCleanly_TakesSiblingType()
    {
        const string Source = @"package Issue1018.BindTernary

import System

func f(cond bool, a int32) int32 {
    return cond ? a : throw Exception(""nope"")
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void ReturnThrowExpression_BindsCleanly()
    {
        const string Source = @"package Issue1018.BindReturn

import System

func f(b bool) string {
    return throw Exception(""always"")
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void ThrowExpression_NonException_IsRejected()
    {
        const string Source = @"package Issue1018.NegBind

func f(s string?) string {
    return s ?? throw 42
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.Contains(diagnostics, d => d.IsError && d.Message.Contains("System.Exception"));
    }

    [Theory]
    [InlineData("int32")]
    [InlineData("string")]
    [InlineData("void")]
    public void NeverReturningFunction_ConvertsToAnyFunctionResult(string resultName)
    {
        var resultType = resultName switch
        {
            "int32" => TypeSymbol.Int32,
            "string" => TypeSymbol.String,
            _ => TypeSymbol.Void,
        };
        var from = FunctionTypeSymbol.Get(ImmutableArray<TypeSymbol>.Empty, TypeSymbol.Never);
        var to = FunctionTypeSymbol.Get(ImmutableArray<TypeSymbol>.Empty, resultType);

        var conversion = Conversion.Classify(from, to);

        Assert.True(conversion.Exists);
        Assert.True(conversion.IsImplicit);
    }

    [Theory]
    [InlineData(typeof(Func<int>))]
    [InlineData(typeof(Func<string>))]
    [InlineData(typeof(Action))]
    public void NeverReturningFunction_ConvertsToAnyClrDelegateResult(Type delegateType)
    {
        var from = FunctionTypeSymbol.Get(ImmutableArray<TypeSymbol>.Empty, TypeSymbol.Never);

        var conversion = Conversion.Classify(from, ImportedTypeSymbol.Get(delegateType));

        Assert.True(conversion.Exists);
        Assert.True(conversion.IsImplicit);
    }

    [Fact]
    public void OahuServiceFactory_ThrowExpressionInitializer_BindsCleanly()
    {
        const string Source = """
            package Oahu.Cli.Server.Hosting
            import System

            interface IAuthService {
            }

            class ServerHost {
                class ServiceFactories {
                    private var _auth () -> IAuthService = () -> throw InvalidOperationException("AuthFactory not configured")
                }
            }
            """;

        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void NonBottomReturnAndParameterMismatches_StayRejected()
    {
        var noParameters = ImmutableArray<TypeSymbol>.Empty;
        var wrongReturn = Conversion.Classify(
            FunctionTypeSymbol.Get(noParameters, TypeSymbol.String),
            FunctionTypeSymbol.Get(noParameters, TypeSymbol.Int32));
        var wrongParameter = Conversion.Classify(
            FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(TypeSymbol.String), TypeSymbol.Never),
            FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32), TypeSymbol.String));

        Assert.False(wrongReturn.Exists);
        Assert.False(wrongParameter.Exists);

        const string Source = """
            package Issue2716.Negative

            interface IAuthService {
            }

            class ServiceFactories {
                private var _auth () -> IAuthService = () -> "not an auth service"
            }
            """;
        Assert.Contains(EmitDiagnostics(Source), d => d.IsError && d.Id == "GS0155");
    }

    private static System.Collections.Generic.IEnumerable<SyntaxNode> Descendants(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            foreach (var descendant in Descendants(child))
            {
                yield return descendant;
            }
        }
    }
}
