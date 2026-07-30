// <copyright file="Issue2883FixedEscapingBranchFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2883: definite-return analysis must see branches that escape a
/// structured <c>fixed</c> or <c>scope</c> body.
/// </summary>
public class Issue2883FixedEscapingBranchFlowTests
{
    [Fact]
    public void BreakOutOfFixed_ReportsGs0100()
    {
        const string Source = """
            package Issue2883.Break

            func F(xs []int32) int32 {
                unsafe {
                    for {
                        fixed p *int32 = xs {
                            break
                        }
                    }
                }
            }
            """;

        AssertGs0100(Source);
    }

    [Fact]
    public void BreakOutOfNestedFixed_ReportsGs0100()
    {
        const string Source = """
            package Issue2883.NestedBreak

            func F(xs []int32) int32 {
                unsafe {
                    for {
                        fixed p *int32 = xs {
                            fixed q *int32 = xs {
                                break
                            }
                        }
                    }
                }
            }
            """;

        AssertGs0100(Source);
    }

    [Fact]
    public void LabeledBreakOutOfFixed_ReportsGs0100()
    {
        const string Source = """
            package Issue2883.LabeledBreak

            func F(xs []int32) int32 {
                unsafe {
                    outer: for {
                        for {
                            fixed p *int32 = xs {
                                break outer
                            }
                        }
                    }
                }
            }
            """;

        AssertGs0100(Source);
    }

    [Fact]
    public void GotoOutOfFixed_ReportsGs0100()
    {
        const string Source = """
            package Issue2883.Goto

            func F(xs []int32) int32 {
                unsafe {
                    fixed p *int32 = xs {
                        goto done
                    }
                }
                return 1
            done:
                var reached = true
            }
            """;

        AssertGs0100(Source);
    }

    [Fact]
    public void ContinueOutOfFixed_PreservesInfiniteLoop()
    {
        const string Source = """
            package Issue2883.Continue

            func F(xs []int32) int32 {
                unsafe {
                    for {
                        fixed p *int32 = xs {
                            continue
                        }
                        break
                    }
                }
            }
            """;

        AssertNoGs0100(Source);
    }

    [Fact]
    public void LabeledContinueOutOfFixed_PreservesInfiniteLoop()
    {
        const string Source = """
            package Issue2883.LabeledContinue

            func F(xs []int32) int32 {
                unsafe {
                    outer: for {
                        for {
                            fixed p *int32 = xs {
                                continue outer
                            }
                            break outer
                        }
                    }
                }
            }
            """;

        AssertNoGs0100(Source);
    }

    [Fact]
    public void BreakOutOfScope_ReportsGs0100()
    {
        const string Source = """
            package Issue2883.ScopeBreak

            func F() int32 {
                for {
                    scope {
                        break
                    }
                }
            }
            """;

        AssertGs0100(Source);
    }

    [Fact]
    public void GotoOutOfScope_ReportsGs0100()
    {
        const string Source = """
            package Issue2883.ScopeGoto

            func F() int32 {
                scope {
                    goto done
                }
                return 1
            done:
                var reached = true
            }
            """;

        AssertGs0100(Source);
    }

    private static void AssertGs0100(string source)
    {
        var diagnostics = Compile(source);
        var diagnostic = Assert.Single(diagnostics.Where(candidate => candidate.IsError));
        Assert.Equal("GS0100", diagnostic.Id);
        Assert.Equal("F", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    private static void AssertNoGs0100(string source)
    {
        var diagnostics = Compile(source);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
