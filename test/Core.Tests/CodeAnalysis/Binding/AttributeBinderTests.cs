// <copyright file="AttributeBinderTests.cs" company="GSharp">
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
/// Tests for ADR-0047 Phase 2 attribute binding: name resolution against the
/// declaring scope, use-site target validation, and compile-time constant
/// argument checking. Annotations on type aliases and parameters are bound
/// for diagnostics; the bound-attribute list itself is asserted via the
/// owning <see cref="GSharp.Core.CodeAnalysis.Symbols.Symbol.Attributes"/>
/// slot for functions, structs, and interfaces.
/// </summary>
public class AttributeBinderTests
{
    [Fact]
    public void Resolves_Obsolete_With_Attribute_Suffix()
    {
        // `@Obsolete` resolves to System.ObsoleteAttribute via the suffix rule.
        var globalScope = BindSource("@Obsolete\nfunc Helper() {\n}\n");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");

        Assert.Single(helper.Attributes);
        Assert.Equal("System.ObsoleteAttribute", helper.Attributes[0].AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Method, helper.Attributes[0].Target);
        Assert.Empty(GetBinderDiagnostics(globalScope));
    }

    [Fact]
    public void Resolves_Obsolete_With_Message_Argument()
    {
        var globalScope = BindSource("@Obsolete(\"use Bar instead\")\nfunc Foo() {\n}\n");
        var foo = globalScope.Functions.Single(f => f.Name == "Foo");

        var attr = Assert.Single(foo.Attributes);
        var posArg = Assert.Single(attr.PositionalArguments);
        Assert.Equal("use Bar instead", posArg.Value);
        Assert.Empty(GetBinderDiagnostics(globalScope));
    }

    [Fact]
    public void Reports_Unknown_Attribute_Type()
    {
        var globalScope = BindSource("@DoesNotExistAnywhere\nfunc Helper() {\n}\n");

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0198");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");
        Assert.Empty(helper.Attributes);
    }

    [Fact]
    public void Reports_When_Type_Is_Not_An_Attribute()
    {
        // `int` resolves but is not a System.Attribute subclass — must report GS0200.
        var globalScope = BindSource("@int\nfunc Helper() {\n}\n");

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0200");
    }

    [Fact]
    public void Reports_Invalid_Use_Site_Target_On_Function()
    {
        // `@field:` is not valid on a function declaration.
        var globalScope = BindSource("@field:Obsolete\nfunc Helper() {\n}\n");

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0201");
    }

    [Fact]
    public void Allows_Return_Use_Site_Target_On_Function()
    {
        var globalScope = BindSource("@return:Obsolete\nfunc Helper() {\n}\n");

        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), d => d.Id == "GS0201");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");
        var attr = Assert.Single(helper.Attributes);
        Assert.Equal(AttributeTargetKind.Return, attr.Target);
    }

    [Fact]
    public void Reports_Non_Constant_Attribute_Argument()
    {
        // A nameof(...) expression isn't a recognised literal-shaped constant
        // for v1 — it must report GS0202.
        var globalScope = BindSource("@Obsolete(nameof(Helper))\nfunc Helper() {\n}\n");

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0202");
    }

    [Fact]
    public void Attaches_Attributes_To_Struct_Symbol()
    {
        var source = @"
@Obsolete
type Point struct {
    X int
    Y int
}
";
        var globalScope = BindSource(source);
        var point = globalScope.Structs.Single(t => t.Name == "Point");

        Assert.Single(point.Attributes);
        Assert.Equal(AttributeTargetKind.Type, point.Attributes[0].Target);
    }

    [Fact]
    public void Reports_Invalid_Use_Site_Target_On_Struct()
    {
        var source = @"
@method:Obsolete
type Point struct {
    X int
}
";
        var globalScope = BindSource(source);

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0201");
    }

    [Fact]
    public void Binds_Multiple_Stacked_Annotations()
    {
        var globalScope = BindSource("@Obsolete\n@Obsolete(\"again\")\nfunc Helper() {\n}\n");
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");

        Assert.Equal(2, helper.Attributes.Length);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> GetBinderDiagnostics(BoundGlobalScope scope)
    {
        return scope.Diagnostics;
    }
}
