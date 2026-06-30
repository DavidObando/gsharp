// <copyright file="PatternTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Binder coverage for Phase 6.2 switch patterns.</summary>
public class PatternTests
{
    [Fact]
    public void TypePattern_BindsVariableOnlyInArmScope()
    {
        var diagnostics = Bind(@"
class User { var Name string }
let u = User{Name: ""x""}
let a = switch u { case v is User: v.Name default: ""n"" }
let b = v.Name
");

        Assert.Contains(diagnostics, d => d.Message.Contains("v", System.StringComparison.Ordinal));
    }

    [Fact]
    public void PropertyPattern_OnNonStruct_Diagnoses()
    {
        var diagnostics = Bind(@"let x = switch 1 { case { Name: ""x"" }: 1 default: 0 }");
        Assert.Contains(diagnostics, d => d.Message.Contains("Property pattern requires", System.StringComparison.Ordinal));
    }

    [Fact]
    public void PropertyPattern_MissingField_Diagnoses()
    {
        var diagnostics = Bind(@"
class User { var Name string }
let u = User{Name: ""x""}
let x = switch u { case { Missing: 1 }: 1 default: 0 }
");
        Assert.Contains(diagnostics, d => d.Message.Contains("does not define a field named 'Missing'", System.StringComparison.Ordinal));
    }

    [Fact]
    public void RelationalPattern_UndefinedOperator_Diagnoses()
    {
        var diagnostics = Bind("let x = switch true { case > false: 1 default: 0 }");
        Assert.Contains(diagnostics, d => d.Message.Contains("Relational pattern operator '>' is not defined", System.StringComparison.Ordinal));
    }

    [Fact]
    public void ListPattern_OnNonArray_Diagnoses()
    {
        var diagnostics = Bind("let x = switch 1 { case [1]: 1 default: 0 }");
        Assert.Contains(diagnostics, d => d.Message.Contains("List pattern requires", System.StringComparison.Ordinal));
    }

    [Fact]
    public void DiscardPattern_AcceptsAnyDiscriminantType()
    {
        var diagnostics = Bind(@"
class User { var Name string }
let u = User{Name: ""x""}
let x = switch u { case _: 1 }
");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SlicePattern_DiscardForms_BindWithoutError()
    {
        var diagnostics = Bind(@"
let xs = []int32{1, 2, 3}
let x = switch xs { case [1, .., 3]: 1 case [..]: 2 default: 0 }
");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SlicePattern_PrefixAndSuffixWithNestedPatterns_BindWithoutError()
    {
        var diagnostics = Bind(@"
let xs = []int32{1, 2, 3}
let x = switch xs { case [> 0, .., _]: 1 default: 0 }
");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void CapturedSlice_BindsVariableWithSliceElementType()
    {
        // 'rest' must have type []int32; assigning it to a []int32 local must bind clean.
        var diagnostics = Bind(@"
let xs = []int32{1, 2, 3}
switch xs {
    case [_, ..rest, _] {
        let s []int32 = rest
    }
    default { }
}
");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void CapturedSlice_UsedAsElementType_Diagnoses()
    {
        // 'rest' is []int32, not int32, so assigning to an int32 local must fail.
        var diagnostics = Bind(@"
let xs = []int32{1, 2, 3}
switch xs {
    case [_, ..rest, _] {
        let s int32 = rest
    }
    default { }
}
");
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void SlicePattern_MultipleSlices_Diagnoses()
    {
        var diagnostics = Bind(@"
let xs = []int32{1, 2, 3}
let x = switch xs { case [1, .., .., 3]: 1 default: 0 }
");
        Assert.Contains(diagnostics, d => d.Message.Contains("at most one slice", System.StringComparison.Ordinal));
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
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
