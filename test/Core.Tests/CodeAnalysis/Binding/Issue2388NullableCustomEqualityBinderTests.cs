// <copyright file="Issue2388NullableCustomEqualityBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2388: Emitted-oracle coverage for nullable custom equality.
/// </summary>
public class Issue2388NullableCustomEqualityBinderTests
{
    [Fact]
    public void DateTimeNullable_Equality_BindsClean()
    {
        var source = @"
import System
func F(a DateTime?, b DateTime?) bool {
    return a == b
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void DateTimeNullable_Inequality_BindsClean()
    {
        var source = @"
import System
func F(a DateTime?, b DateTime?) bool {
    return a != b
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Theory]
    [InlineData("<")]
    [InlineData("<=")]
    [InlineData(">")]
    [InlineData(">=")]
    public void DateTimeNullable_Ordering_BindsClean(string op)
    {
        var source = $@"
import System
func F(a DateTime?, b DateTime?) bool {{
    return a {op} b
}}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void DateTimeNullable_MixedModeAgainstNonNullable_BindsClean()
    {
        var source = @"
import System
func F(a DateTime?, b DateTime) bool {
    return a == b
}
func G(a DateTime, b DateTime?) bool {
    return a == b
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void DateTimeNullable_AgainstNil_StillBindsCleanViaExistingIsNullCompareArm()
    {
        // Not touched by this fix (IsNullCompare fires before Stream C/D is
        // ever reached) — regression guard proving the new lifting logic
        // doesn't interfere with it.
        var source = @"
import System
func F(a DateTime?) bool {
    return a == nil
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void GuidNullable_EqualityAndInequality_BindClean()
    {
        var source = @"
import System
func F(a Guid?, b Guid?) bool {
    return a == b
}
func G(a Guid?, b Guid?) bool {
    return a != b
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void SameCompilationStruct_NullableEquality_StreamD_BindsClean()
    {
        // Issue #2388 "directly related deferred work" control: a
        // same-compilation struct's user-defined operator (Stream D) is
        // resolved via TypeMemberModel against the struct symbol; before
        // this fix, `T? == T?` never unwrapped the NullableTypeSymbol
        // before the `is StructSymbol` check and always reported GS0129
        // even though the struct DOES declare `operator ==`.
        var source = @"
struct Meters(Value float64) {
}

func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value
func (a Meters) operator !=(b Meters) bool -> !(a == b)

func F(a Meters?, b Meters?) bool {
    return a == b
}
func G(a Meters?, b Meters?) bool {
    return a != b
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void SameCompilationStruct_WithoutUserOperator_NullableEquality_StillReportsGS0129()
    {
        // Negative control: the fix only unwraps NullableTypeSymbol to find
        // an EXISTING user operator — it must not fabricate equality for a
        // struct that never declared one.
        var source = @"
struct Plain(Value float64) {
}

func F(a Plain?, b Plain?) bool {
    return a == b
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void SameCompilationStruct_NonNullableEquality_StillBindsClean_Regression()
    {
        // Regression guard: the non-nullable Stream D call path (plain
        // BoundCallExpression, untouched by this fix) still binds.
        var source = @"
struct MetersB(Value float64) {
}

func (a MetersB) operator ==(b MetersB) bool -> a.Value == b.Value

func F(a MetersB, b MetersB) bool {
    return a == b
}
";
        AssertNoErrors(Evaluate(source));
    }

    private static void AssertNoErrors(EmittedOracleResult result)
    {
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
