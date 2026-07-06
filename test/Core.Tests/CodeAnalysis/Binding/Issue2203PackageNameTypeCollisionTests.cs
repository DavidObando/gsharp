// <copyright file="Issue2203PackageNameTypeCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2203: a type whose simple name equals the last segment of its own
/// containing package (e.g. <c>class Tokens</c> in <c>package
/// Oahu.Cli.Tui.Tokens</c>) failed member resolution with GS0158 when
/// referenced from a sibling package as <c>Tokens.Tokens.Member</c>. This
/// double-qualified form arises from cs2gs translating C# source that relies
/// on the sibling-namespace-visibility rule (a nested namespace is visible
/// unqualified from a sibling namespace under a shared ancestor) — the
/// leading "Tokens" plays the namespace's role there, but G# has no namespace
/// concept and instead resolves the type by simple name from its flat,
/// cross-package type scope, so the leading qualifier is redundant and must
/// be peeled off.
/// </summary>
public class Issue2203PackageNameTypeCollisionTests
{
    [Fact]
    public void TypeNameEqualsPackageTail_DoubleQualifiedStaticMethodCall_Resolves()
    {
        var tree1 = SyntaxTree.Parse(SourceText.From("""
            package Oahu.Cli.Tui.Tokens
            open class Tokens {
                shared {
                    func Hello() string { return "hi" }
                }
            }
            """));
        var tree2 = SyntaxTree.Parse(SourceText.From("""
            package Oahu.Cli.Tui.Widgets
            Console.WriteLine(Tokens.Tokens.Hello())
            """));

        Assert.Empty(BindDiagnostics(tree1, tree2));
    }

    [Fact]
    public void TypeNameEqualsPackageTail_DoubleQualifiedStaticFieldAccess_Resolves()
    {
        var tree1 = SyntaxTree.Parse(SourceText.From("""
            package Oahu.Cli.Tui.Tokens
            open class Tokens {
                shared {
                    var TextPrimary string = "primary"
                }
            }
            """));
        var tree2 = SyntaxTree.Parse(SourceText.From("""
            package Oahu.Cli.Tui.Widgets
            Console.WriteLine(Tokens.Tokens.TextPrimary)
            """));

        Assert.Empty(BindDiagnostics(tree1, tree2));
    }

    [Fact]
    public void TypeNameDoesNotEqualPackageTail_DoubleQualifiedCall_StillReportsUnresolvedMember()
    {
        // Regression guard: the fix must not blanket-accept every "X.X.Member"
        // shape — it only peels the qualifier when the type's own package tail
        // actually matches the qualifier. Here "Widgets" (the package tail) does
        // not match "Tokens" (the leading qualifier), so the erroneous double
        // qualification should still surface as an unresolved-member error.
        var tree1 = SyntaxTree.Parse(SourceText.From("""
            package Oahu.Cli.Tui.Widgets
            open class Tokens {
                shared {
                    func Hello() string { return "hi" }
                }
            }
            """));
        var tree2 = SyntaxTree.Parse(SourceText.From("""
            package Oahu.Cli.Tui.Other
            Console.WriteLine(Tokens.Tokens.Hello())
            """));

        Assert.Contains(BindDiagnostics(tree1, tree2), d => d.Id == "GS0158");
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> BindDiagnostics(params SyntaxTree[] trees)
    {
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(trees));
        var program = Binder.BindProgram(globalScope);
        return globalScope.Diagnostics.Concat(program.Diagnostics).ToImmutableArray();
    }
}
