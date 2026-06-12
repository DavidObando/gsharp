// <copyright file="ObjectInitializerBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #522: binder tests for the C#-style object-initializer suffix.
/// Confirms that:
///   * Initializers against a user-defined class assign the named fields.
///   * Initializers against a writable property succeed.
///   * Initializers against an unknown member surface a precise diagnostic.
///   * Initializers against a non-writable member surface a precise
///     diagnostic.
/// </summary>
public class ObjectInitializerBinderTests
{
    [Fact]
    public void Binds_AgainstUserDefinedClassFields()
    {
        var source = @"
class Box {
    var Width int32
    var Height int32
    init() { }
}

var b = Box() { Width = 3, Height = 4 }
b.Width + b.Height
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Binds_AgainstUserDefinedClassProperty()
    {
        var source = @"
class Box {
    prop Width int32
    prop Height int32
    init() { }
}

var b = Box() { Width = 5, Height = 6 }
b.Width + b.Height
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void Binds_EmptyInitializerListYieldsConstructedInstance()
    {
        var source = @"
class Box {
    var Width int32
    init() { }
}

var b = Box() { }
b.Width
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Diagnoses_UnknownMemberName()
    {
        var source = @"
class Box {
    var Width int32
    init() { }
}

var b = Box() { Unknown = 1 }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Unknown"));
    }

    [Fact]
    public void Diagnoses_DuplicatePropertyName()
    {
        var source = @"
class Box {
    var Width int32
    init() { }
}

var b = Box() { Width = 1, Width = 2 }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Diagnoses_NonWritableProperty()
    {
        var source = @"
class Box {
    prop Width int32 { get }
    init() { }
}

var b = Box() { Width = 1 }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
