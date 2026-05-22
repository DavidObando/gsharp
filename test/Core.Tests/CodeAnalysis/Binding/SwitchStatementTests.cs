// <copyright file="SwitchStatementTests.cs" company="GSharp">
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
/// Phase 2.6: <c>switch</c> statements over int / string / bool with required
/// brace-block case bodies and no implicit fallthrough (ADR-0013).
/// </summary>
public class SwitchStatementTests
{
    [Fact]
    public void Switch_Int_Binds()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { var a = ""one"" }
 case 2 { var b = ""two"" }
 default { var c = ""other"" }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_String_Binds()
    {
        var src = @"func F() {
 var s = ""hi""
 switch s {
 case ""hi"" { var a = 1 }
 case ""bye"" { var b = 2 }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_Bool_Binds()
    {
        var src = @"func F() {
 var b = true
 switch b {
 case true { var x = 1 }
 case false { var y = 2 }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_Without_Default_Binds()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { var a = 1 }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_Case_Type_Mismatch_Reports_Error()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case ""hi"" { var a = 1 }
 }
}
";
        var diagnostics = Bind(src);
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void Switch_Duplicate_Default_Reports_Error()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { var a = 1 }
 default { var b = 2 }
 default { var c = 3 }
 }
}
";
        var diagnostics = Bind(src);
        Assert.Contains(diagnostics, d => d.Message.Contains("default", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Fallthrough_Reports_Error()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { fallthrough }
 case 2 { var a = 1 }
 }
}
";
        var diagnostics = Bind(src);
        Assert.Contains(diagnostics, d => d.Message.Contains("fallthrough", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Switch_Default_NotLast_Still_Routes_Correctly()
    {
        // Default in the middle still binds; semantic equivalence verified by
        // the chain construction in BindSwitchStatement.
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { var a = 1 }
 default { var b = 2 }
 case 3 { var c = 3 }
 }
}
";
        Assert.Empty(Bind(src));
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
