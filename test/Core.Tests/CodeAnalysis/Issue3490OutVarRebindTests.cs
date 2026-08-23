// <copyright file="Issue3490OutVarRebindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3490: a bare call to a sibling <c>shared</c> function whose
/// argument subtree carries an inline <c>out var</c> declaration reported
/// GS9002 + GS0102 for the same declaration — BindCallExpression pre-binds
/// every argument for overload probing (declaring the out local), then the
/// implicit static-self finalizer re-binds the whole call from syntax and
/// the second declaration collided. A same-syntax collision now reuses the
/// already-declared local; genuinely duplicate declarations (distinct
/// syntax) still report GS0102.
/// </summary>
public class Issue3490OutVarRebindTests
{
    [Fact]
    public void BareSiblingCall_OutVarInIfExpressionArgument_BindsAndRuns()
    {
        var source = @"
class W {
    shared {
        private func Format(value int32) string -> ""v"" + value.ToString()

        func Run() string {
            return Format(if int.TryParse(""42"", out var v) { v } else { 0 })
        }
    }
}

W.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("v42", result.Value);
    }

    [Fact]
    public void BareSiblingCall_OutVarUsedAfterCall_BindsAndRuns()
    {
        var source = @"
class W {
    shared {
        private func Touch(flag bool) bool -> flag

        func Run() int32 {
            if Touch(int.TryParse(""7"", out var v)) {
                return v
            }
            return 0
        }
    }
}

W.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void GenuineDuplicateOutVar_StillReportsAlreadyDeclared()
    {
        var source = @"
class W {
    func Bad(text string) int32 {
        if int.TryParse(text, out var v) && int.TryParse(text, out var v) {
            return v
        }
        return 0
    }
}
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0102");
    }

    [Fact]
    public void QualifiedSiblingCall_OutVarArgument_StillBindsAndRuns()
    {
        var source = @"
class W {
    shared {
        private func Format(value int32) string -> ""v"" + value.ToString()

        func Run() string {
            return W.Format(if int.TryParse(""3"", out var v) { v } else { 0 })
        }
    }
}

W.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("v3", result.Value);
    }
}
