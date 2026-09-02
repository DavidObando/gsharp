// <copyright file="Issue2906ExhaustiveSwitchReturnFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2906: closed-discriminant exhaustiveness must feed definite-return
/// analysis without treating guarded, nullable, or incomplete switches as total.
/// </summary>
public class Issue2906ExhaustiveSwitchReturnFlowTests
{
    /// <summary>Gets exhaustive switches that must not report GS0100.</summary>
    public static IEnumerable<object[]> ExhaustiveCases()
    {
        yield return Case("OneMember", """
            enum E { A }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                }
            }
            """);
        yield return Case("TwoMembers", """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B { return 2 }
                }
            }
            """);
        yield return Case("ManyMembers", """
            enum E { A, B, C, D }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B { return 2 }
                    case E.C { return 3 }
                    case E.D { return 4 }
                }
            }
            """);
        yield return Case("RedundantDefault", """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B { return 2 }
                    default { return 3 }
                }
            }
            """);
        yield return Case("DuplicateCompleteArms", """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.A { return 2 }
                    case E.B { return 3 }
                }
            }
            """);
        yield return Case("OrPattern", """
            enum E { A, B, C }
            func F(x E) int32 {
                switch x {
                    case E.A or E.B { return 1 }
                    case E.C { return 2 }
                }
            }
            """);
        yield return Case("SealedInterface", """
            sealed interface Expr { }
            class Add : Expr { }
            class Mul : Expr { }
            func F(x Expr) int32 {
                switch x {
                    case _ is Add { return 1 }
                    case _ is Mul { return 2 }
                }
            }
            """);
        yield return Case("SealedClass", """
            sealed class Shape { }
            class Circle : Shape { }
            class Square : Shape { }
            func F(x Shape) int32 {
                switch x {
                    case _ is Circle { return 1 }
                    case _ is Square { return 2 }
                }
            }
            """);
        yield return Case("SwitchInsideTry", """
            enum E { A, B }
            func F(x E) int32 {
                try {
                    switch x {
                        case E.A { return 1 }
                        case E.B { return 2 }
                    }
                } finally {
                }
            }
            """);
        yield return Case("TryInsideArms", """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A {
                        try {
                            return 1
                        } finally {
                        }
                    }
                    case E.B {
                        try {
                            return 2
                        } finally {
                        }
                    }
                }
            }
            """);
        yield return Case("SwitchInsideSelect", """
            enum E { A, B }
            func F(x E) int32 {
                select {
                    default {
                        switch x {
                            case E.A { return 1 }
                            case E.B { return 2 }
                        }
                    }
                }
            }
            """);
    }

    /// <summary>Gets non-total switches that must still report GS0100.</summary>
    public static IEnumerable<object[]> NonExhaustiveCases()
    {
        yield return Case("MissingMember", """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                }
            }
            """);
        yield return Case("DuplicateMissingMember", """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.A { return 2 }
                }
            }
            """);
        yield return Case("GuardedMember", """
            enum E { A, B }
            func F(x E, allow bool) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B when allow { return 2 }
                }
            }
            """);
        yield return Case("NullableEnum", """
            enum E { A, B }
            func F(x E?) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B { return 2 }
                }
            }
            """);
        yield return Case("OrdinaryInt", """
            func F(x int32) int32 {
                switch x {
                    case 0 { return 1 }
                    case 1 { return 2 }
                }
            }
            """);
    }

    [Theory]
    [MemberData(nameof(ExhaustiveCases))]
    public void ExhaustiveClosedSwitch_DoesNotReportGs0100(string name, string source)
    {
        _ = name;
        var (diagnostics, emittedLength) = Compile(source);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
        Assert.True(emittedLength > 0);
    }

    [Theory]
    [MemberData(nameof(NonExhaustiveCases))]
    public void NonTotalSwitch_ReportsGs0100(string name, string source)
    {
        _ = name;
        var (diagnostics, emittedLength) = Compile(source);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0100");
        Assert.Equal(0, emittedLength);
    }

    [Fact]
    public void ImportedFlagsEnums_RetainStatementAndExpressionExhaustivenessDiagnostics()
    {
        const string StatementSource = """
            package Issue2906.FlagsStatement
            import System
            func F(x StringSplitOptions) {
                switch x {
                    case StringSplitOptions.None { }
                }
            }
            """;
        const string ExpressionSource = """
            package Issue2906.FlagsExpression
            import System
            func F(x StringSplitOptions) int32 {
                return switch x {
                    case StringSplitOptions.None: 0
                }
            }
            """;

        var (statementDiagnostics, _) = Compile(StatementSource);
        var (expressionDiagnostics, _) = Compile(ExpressionSource);
        Assert.Contains(statementDiagnostics, diagnostic => diagnostic.Id == "GS0178");
        Assert.Contains(expressionDiagnostics, diagnostic => diagnostic.Id == "GS0177");
        Assert.DoesNotContain(expressionDiagnostics, diagnostic => diagnostic.Id == "GS0176");
    }

    private static object[] Case(string name, string body)
        => new object[] { name, $"package Issue2906.{name}{Environment.NewLine}{body}" };

    private static (System.Collections.Immutable.ImmutableArray<Diagnostic> Diagnostics, long EmittedLength) Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return (compilation.Emit(peStream).Diagnostics, peStream.Length);
    }
}
