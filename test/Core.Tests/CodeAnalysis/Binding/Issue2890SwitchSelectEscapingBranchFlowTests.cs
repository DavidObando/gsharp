// <copyright file="Issue2890SwitchSelectEscapingBranchFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2890: definite-return CFG must model pattern-switch and select arms
/// as alternatives while preserving branches that escape those arms.
/// </summary>
public class Issue2890SwitchSelectEscapingBranchFlowTests
{
    [Fact]
    public void BreakOutOfPatternSwitchArm_ExitsSwitchAndBindsClean()
    {
        const string Source = """
            package Issue2890.SwitchBreak

            func F(x int32) int32 {
                for {
                    switch x {
                        default { break }
                    }
                }
            }
            """;

        AssertBindsClean(Source);
    }

    [Fact]
    public void BreakOutOfSelectDefaultArm_ExitsSelectAndBindsClean()
    {
        const string Source = """
            package Issue2890.SelectBreak
            import Gsharp.Extensions.Go

            func F() int32 {
                for {
                    select {
                        default { break }
                    }
                }
            }
            """;

        AssertBindsClean(Source);
    }

    [Fact]
    public void BreakOutOfRealSelectArm_ExitsSelectAndBindsClean()
    {
        const string Source = """
            package Issue2890.SelectRealBreak
            import Gsharp.Extensions.Go

            func F() int32 {
                let ch = make(chan int32, 1)
                for {
                    select {
                        case ch <- 1 { break }
                        case <-ch { continue }
                        default { continue }
                    }
                }
            }
            """;

        AssertBindsClean(Source);
    }

    [Fact]
    public void BreakOutOfNestedPatternSwitchArm_ExitsInnerSwitchAndBindsClean()
    {
        const string Source = """
            package Issue2890.NestedSwitchBreak

            func F(x int32, y int32) int32 {
                for {
                    switch x {
                        case 1 {
                            switch y {
                                default { break }
                            }
                        }
                        default { continue }
                    }
                }
            }
            """;

        AssertBindsClean(Source);
    }

    [Fact]
    public void LabeledBreakOutOfPatternSwitchArm_ReportsGs0100()
    {
        const string Source = """
            package Issue2890.LabeledSwitchBreak

            func F(x int32) int32 {
                outer: for {
                    for {
                        switch x {
                            default { break outer }
                        }
                    }
                }
            }
            """;

        AssertOnlyGs0100(Source);
    }

    [Fact]
    public void GotoOutOfPatternSwitchArm_ReportsGs0100()
    {
        const string Source = """
            package Issue2890.SwitchGoto

            func F(x int32) int32 {
                switch x {
                    case 1 { goto done }
                    default { return 1 }
                }
                return 2
            done:
                var reached = true
            }
            """;

        AssertOnlyGs0100(Source);
    }

    [Fact]
    public void GotoOutOfSelectArm_ReportsGs0100()
    {
        const string Source = """
            package Issue2890.SelectGoto
            import Gsharp.Extensions.Go

            func F() int32 {
                select {
                    default { goto done }
                }
                return 1
            done:
                var reached = true
            }
            """;

        AssertOnlyGs0100(Source);
    }

    [Fact]
    public void PatternSwitchInsideFixedBreak_ExitsSwitchAndBindsClean()
    {
        const string Source = """
            package Issue2890.SwitchFixedBreak

            func F(x int32, xs []int32) int32 {
                unsafe {
                    for {
                        fixed p *int32 = xs {
                            switch x {
                                default { break }
                            }
                        }
                    }
                }
            }
            """;

        AssertBindsClean(Source);
    }

    [Fact]
    public void PatternSwitchInsideScopeBreak_ExitsSwitchAndBindsClean()
    {
        const string Source = """
            package Issue2890.SwitchScopeBreak
            import Gsharp.Extensions.Go

            func F(x int32) int32 {
                for {
                    scope {
                        switch x {
                            default { break }
                        }
                    }
                }
            }
            """;

        AssertBindsClean(Source);
    }

    [Fact]
    public void LiteralSwitchWithoutDefault_DoesNotReportGs0100()
    {
        const string Source = """
            package Issue2890.LiteralNoDefault

            func F() int32 {
                switch 1 {
                    case 1 { return 10 }
                    case 2 { return 20 }
                }
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void ImpossibleLiteralArmBreak_DoesNotReportGs0100()
    {
        const string Source = """
            package Issue2890.ImpossibleLiteralBreak

            func F() int32 {
                for {
                    switch 1 {
                        case 2 { break }
                    }
                }
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void FalseGuardArmBreak_ExitsSwitchAndBindsClean()
    {
        const string Source = """
            package Issue2890.FalseGuardBreak

            func F(x int32) int32 {
                for {
                    switch x {
                        case _ when false { break }
                        default { return 1 }
                    }
                }
            }
            """;

        AssertBindsClean(Source);
    }

    [Fact]
    public void CompletingSwitchArmDoesNotFallThroughToDefault_ReportsGs0100()
    {
        const string Source = """
            package Issue2890.SwitchArmCompletion

            func F(x int32) int32 {
                switch x {
                    case 1 { }
                    default { return 1 }
                }
            }
            """;

        AssertOnlyGs0100(Source);
    }

    [Fact]
    public void CompletingSelectArmDoesNotFallThroughToDefault_ReportsGs0100()
    {
        const string Source = """
            package Issue2890.SelectArmCompletion
            import Gsharp.Extensions.Go

            func F() int32 {
                let ch = make(chan int32, 1)
                select {
                    case ch <- 1 { }
                    default { return 1 }
                }
            }
            """;

        AssertOnlyGs0100(Source);
    }

    [Fact]
    public void SelectWhoseEveryArmReturns_DoesNotReportGs0100()
    {
        const string Source = """
            package Issue2890.SelectReturns
            import Gsharp.Extensions.Go

            func F() int32 {
                let ch = make(chan int32, 1)
                select {
                    case ch <- 1 { return 1 }
                    case <-ch { return 2 }
                    default { return 3 }
                }
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void SelectWithoutDefaultWhoseEveryArmReturns_DoesNotReportGs0100()
    {
        const string Source = """
            package Issue2890.SelectNoDefaultReturns
            import Gsharp.Extensions.Go

            func F() int32 {
                let ch = make(chan int32, 1)
                select {
                    case ch <- 1 { return 1 }
                    case <-ch { return 2 }
                }
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void SelectWhoseEveryArmThrows_DoesNotReportGs0100()
    {
        const string Source = """
            package Issue2890.SelectThrows
            import System
            import Gsharp.Extensions.Go

            func F() int32 {
                let ch = make(chan int32, 1)
                select {
                    case ch <- 1 { throw Exception() }
                    case <-ch { throw Exception() }
                    default { throw Exception() }
                }
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void TotalDiscardSwitchWhoseArmReturns_DoesNotReportGs0100()
    {
        const string Source = """
            package Issue2890.DiscardReturns

            func F(x int32) int32 {
                switch x {
                    case _ { return 1 }
                }
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void SwitchArmContainingReturningSelect_DoesNotReportGs0100()
    {
        const string Source = """
            package Issue2890.SwitchSelectReturns
            import Gsharp.Extensions.Go

            func F(x int32) int32 {
                let ch = make(chan int32, 1)
                switch x {
                    case 1 {
                        select {
                            case ch <- 1 { return 1 }
                            default { return 2 }
                        }
                    }
                    default { return 3 }
                }
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void LiteralSwitchImpossibleEscapingArms_ExitSwitchAndBindClean()
    {
        const string Source = """
            package Issue2890.LiteralSwitch

            func F() int32 {
                for {
                    switch 1 {
                        case 2 { break }
                        case > 5 { break }
                        default { return 1 }
                    }
                }
            }
            """;

        AssertBindsClean(Source);
    }

    [Fact]
    public void PatternSwitchWhoseEveryArmReturns_RemainsValid()
    {
        const string Source = """
            package Issue2890.SwitchReturnsGuard

            func F(x int32) int32 {
                switch x {
                    case 1 { return 1 }
                    default { return 2 }
                }
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void CompletingSwitchArmFollowedByReturn_RemainsValid()
    {
        const string Source = """
            package Issue2890.SwitchThenReturnGuard

            func F(x int32) int32 {
                switch x {
                    case 1 { }
                    default { return 1 }
                }

                return 2
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void TypePatternSwitchWhoseEveryArmReturns_RemainsValid()
    {
        const string Source = """
            package Issue2890.TypePatternGuard

            func F(value object) int32 {
                switch value {
                    case _ is string { return 1 }
                    default { return 2 }
                }
            }
            """;

        AssertNoErrors(Source);
    }


    // Issue #3501 A3: an unlabeled `break` inside a switch/select arm now
    // exits the switch/select (Go/C# alignment), so the enclosing infinite
    // `for` never terminates and the function binds clean — the shapes above
    // stopped being GS0100 escapes. Labeled break still targets the loop and
    // keeps its GS0100 coverage (see the Labeled* tests).
    private static void AssertBindsClean(string source)
    {
        var (result, _) = Compile(source);
        Assert.Empty(result.Diagnostics.Where(candidate => candidate.IsError));
        Assert.True(result.Success);
    }

    private static void AssertOnlyGs0100(string source)
    {
        var (result, emittedLength) = Compile(source);
        var diagnostic = Assert.Single(result.Diagnostics.Where(candidate => candidate.IsError));
        var expectedStart = source.IndexOf("F(", StringComparison.Ordinal);

        Assert.False(result.Success);
        Assert.Equal("GS0100", diagnostic.Id);
        Assert.Equal(expectedStart, diagnostic.Location.Span.Start);
        Assert.Equal(1, diagnostic.Location.Span.Length);
        Assert.Equal("F", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.Equal(0, emittedLength);
    }

    private static void AssertNoErrors(string source)
    {
        var (result, emittedLength) = Compile(source);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.True(emittedLength > 0);
    }

    private static (EmitResult Result, long EmittedLength) Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return (result, peStream.Length);
    }
}
