// <copyright file="Issue1596SwitchExhaustiveReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1596. gsc's definite-return analysis (the <c>AllPathsReturn</c>
/// check that powers GS0100, "Not all code paths return a value") used to
/// treat every <c>switch</c> statement as possibly falling through, even
/// when a <c>default</c> clause was present and every arm definitely
/// returned or threw. That wrongly rejected value-returning functions whose
/// body was an exhaustive switch, while the equivalent if/else compiled
/// fine. A switch WITHOUT a <c>default</c> arm must still be treated as
/// possibly-falling-through.
/// </summary>
public class Issue1596SwitchExhaustiveReturnTests
{
    [Fact]
    public void SwitchWithDefaultOnly_DoesNotReport_AllPathsMustReturn()
    {
        const string Source = @"func I(value object) object {
    switch value {
        default {
            return ""d""
        }
    }
}
";
        AssertNoGs0100(Source);
    }

    [Fact]
    public void SwitchWithDefaultAndCase_DoesNotReport_AllPathsMustReturn()
    {
        const string Source = @"func F(value object) object {
    switch value {
        default {
            return ""d""
        }
        case val is bool {
            return ""b""
        }
    }
}
";
        AssertNoGs0100(Source);
    }

    [Fact]
    public void SwitchWithCaseThenDefault_DoesNotReport_AllPathsMustReturn()
    {
        const string Source = @"func G(value object) object {
    switch value {
        case val is bool {
            return ""b""
        }
        default {
            return ""d""
        }
    }
}
";
        AssertNoGs0100(Source);
    }

    [Fact]
    public void SwitchWithThrowingArm_DoesNotReport_AllPathsMustReturn()
    {
        const string Source = @"package Issue1596.Throw

import System

func T(value object) object {
    switch value {
        case val is bool {
            throw InvalidOperationException(""no"")
        }
        default {
            return ""d""
        }
    }
}
";
        AssertNoGs0100(Source);
    }

    [Fact]
    public void SwitchWithoutDefault_StillReports_AllPathsMustReturn()
    {
        const string Source = @"func N(value object) object {
    switch value {
        case val is bool {
            return ""b""
        }
    }
}
";
        var diagnostics = Compile(Source);
        Assert.Contains(diagnostics, d => d.Id == "GS0100");
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        using var peStream = new System.IO.MemoryStream();
        var emitResult = compilation.Emit(peStream);
        return emitResult.Diagnostics;
    }

    private static void AssertNoGs0100(string source)
    {
        var diagnostics = Compile(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0100");
    }
}
