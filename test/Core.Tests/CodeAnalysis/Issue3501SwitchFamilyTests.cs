// <copyright file="Issue3501SwitchFamilyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3501 Track A3: switch-family C#/Go alignment. An unlabeled
/// <c>break</c> in an arm exits the switch (loops nested in an arm keep
/// their own binding; <c>continue</c> still targets the enclosing loop);
/// <c>case 1, 2 { … }</c> comma multi-pattern arms are sugar for the
/// ADR-0166 <c>or</c> combinator; and <c>fallthrough</c> (previously
/// reserved-and-rejected) gets Go semantics — last statement of a
/// non-final arm, transfers into the next arm's body skipping its pattern
/// test and guard.
/// </summary>
public class Issue3501SwitchFamilyTests
{
    [Fact]
    public void BreakInArm_ExitsSwitch()
    {
        var source = @"
func Run() string {
    var log = """"
    switch 1 {
        case 1 {
            log = log + ""a""
            break
            log = log + ""b""
        }
        default {
            log = log + ""d""
        }
    }
    return log + ""!""
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("a!", result.Value);
    }

    [Fact]
    public void BreakInLoopInsideArm_ExitsLoopNotSwitch()
    {
        var source = @"
func Run() string {
    var log = """"
    switch 1 {
        case 1 {
            for var i = 0; i < 5; i += 1 {
                if i == 2 {
                    break
                }
                log = log + ""i""
            }
            log = log + ""post""
        }
        default {
        }
    }
    return log
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("iipost", result.Value);
    }

    [Fact]
    public void ContinueInArm_TargetsEnclosingLoop()
    {
        var source = @"
func Run() string {
    var log = """"
    for var i = 0; i < 3; i += 1 {
        switch i {
            case 1 {
                continue
            }
            default {
            }
        }
        log = log + ""x""
    }
    return log
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("xx", result.Value);
    }

    [Fact]
    public void CommaArms_MatchAnyListedPattern()
    {
        var source = @"
func Describe(n int32) string {
    switch n {
        case 1, 2, 3 {
            return ""small""
        }
        case 10 {
            return ""ten""
        }
        default {
            return ""big""
        }
    }
}

Describe(2) + Describe(10) + Describe(99)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("smalltenbig", result.Value);
    }

    [Fact]
    public void Fallthrough_ChainsIntoNextArmSkippingItsTest()
    {
        var source = @"
func Chain(n int32) string {
    var log = """"
    switch n {
        case 1 {
            log = log + ""1""
            fallthrough
        }
        case 2 {
            log = log + ""2""
            fallthrough
        }
        default {
            log = log + ""d""
        }
    }
    return log
}

Chain(1) + ""|"" + Chain(2) + ""|"" + Chain(9)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("12d|2d|d", result.Value);
    }

    [Fact]
    public void Fallthrough_NotLastStatement_ReportsGS0168()
    {
        var source = @"
func Run() {
    switch 1 {
        case 1 {
            fallthrough
            var x = 1
        }
        default {
        }
    }
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0168");
    }

    [Fact]
    public void Fallthrough_InFinalArm_ReportsGS0533()
    {
        var source = @"
func Run() {
    switch 1 {
        case 1 {
            fallthrough
        }
    }
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0533");
    }

    [Fact]
    public void Fallthrough_IntoBindingArm_ReportsGS0534()
    {
        var source = @"
func Run(v object) {
    switch v {
        case 1 {
            fallthrough
        }
        case string s {
            System.Console.WriteLine(s)
        }
        default {
        }
    }
}

Run(1)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0534");
    }

    [Fact]
    public void BreakInArm_DoesNotSatisfyAllPathsReturn()
    {
        var source = @"
func F(n int32) int32 {
    switch n {
        case 1 {
            break
        }
        default {
            return 10
        }
    }
}

F(1)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0100");
    }

    [Fact]
    public void ConstantDiscriminant_WithFallthrough_KeepsAllArms()
    {
        // The lowerer's constant-discriminant fast path must not drop the
        // fallthrough target arm.
        var source = @"
func Run() string {
    var log = """"
    switch 1 {
        case 1 {
            log = log + ""one""
            fallthrough
        }
        case 2 {
            log = log + ""two""
        }
        default {
            log = log + ""def""
        }
    }
    return log
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("onetwo", result.Value);
    }
}
