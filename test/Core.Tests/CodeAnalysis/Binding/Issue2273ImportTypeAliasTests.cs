// <copyright file="Issue2273ImportTypeAliasTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2273: <c>import R = Namespace.Type</c> (the analog of C#
/// <c>using R = Namespace.Type;</c>) must let a bare <c>R</c> resolve as the
/// aliased TYPE at use sites — static member access, type-clause position,
/// and nested-type access — for both a same-compilation SOURCE type declared
/// in another package (the conventional resx <c>using R = ...Properties.Resources;</c>
/// pattern) and an imported CLR type.
/// </summary>
public class Issue2273ImportTypeAliasTests
{
    [Fact]
    public void Alias_To_CrossPackage_Source_Type_Resolves_Static_Member_Access()
    {
        var holderTree = @"
package App.Nested

class Holder {
    shared {
        const Message string = ""hi""
    }
}
";
        var mainTree = @"
package App

import R = App.Nested.Holder

var result = R.Message
";
        var result = Evaluate(holderTree, mainTree);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void Alias_To_Imported_Clr_Type_Resolves_Static_Member_Access()
    {
        var result = Evaluate(@"
import R = System.Math

var result = R.Sqrt(16.0)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4.0, result.Value);
    }

    [Fact]
    public void Alias_To_Imported_Open_Generic_Type_Accepts_Type_Arguments()
    {
        var result = Evaluate(@"
import L = System.Collections.Generic.List

let values = L[int32]()
values.Add(42)
var result = values[0]
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Alias_To_CrossPackage_Source_Type_Resolves_In_TypeClause_Position()
    {
        var holderTree = @"
package App.Nested

class Holder {
    prop Value int32

    shared {
        func MakeOne() Holder {
            var h Holder = Holder{Value: 42}
            return h
        }
    }
}
";
        var mainTree = @"
package App

import R = App.Nested.Holder

var h R = R.MakeOne()
var result = h.Value
";
        var result = Evaluate(holderTree, mainTree);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Alias_To_Outer_Type_Resolves_Nested_Type_Access()
    {
        var outerTree = @"
package App.Nested

class Outer {
    class Inner {
        shared {
            const Message string = ""nested-hi""
        }
    }
}
";
        var mainTree = @"
package App

import R = App.Nested.Outer

var result = R.Inner.Message
";
        var result = Evaluate(outerTree, mainTree);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("nested-hi", result.Value);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }

    private static EmittedOracleResult Evaluate(params string[] sources)
    {
        return EmittedOracle.Evaluate(sources);
    }
}
