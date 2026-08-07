// <copyright file="Issue1347BaseAutoPropertyReadBinderTests.cs" company="GSharp">
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
/// Issue #1347: Emitted-oracle coverage for base auto property read.
/// Traceability: issue #1104; diagnostic GS0127.
/// </summary>
public class Issue1347BaseAutoPropertyReadBinderTests
{
    [Fact]
    public void BaseDotAutoProperty_InitOnly_Read_BindsWithoutGS0127()
    {
        var source = @"
open class BaseFile {
    prop Tag int { get; init; }
}

open class DashFile : BaseFile {
    func Read() int {
        return base.Tag
    }
}

let d = DashFile{Tag: 42}
d.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0127");
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void BaseDotAutoProperty_ExpressionBodiedReExposure_BindsWithoutGS0127()
    {
        // The Oahu.Decrypt DashFile shape: an expression-bodied derived member
        // re-exposing the base auto-property (`prop Mirror T -> base.Tag`).
        var source = @"
open class BaseFile {
    prop Tag int { get; init; }
}

open class DashFile : BaseFile {
    prop Mirror int -> base.Tag
}

let d = DashFile{Tag: 7}
d.Mirror
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0127");
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void BaseDotAutoProperty_GetSet_ReadAndWrite_RoundTrips()
    {
        var source = @"
open class BaseFile {
    prop Tag int { get; set; }
}

open class DashFile : BaseFile {
    func Read() int {
        return base.Tag
    }
    func Write(v int) {
        base.Tag = v
    }
}

let d = DashFile{Tag: 1}
d.Write(99)
d.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0127");
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void BaseDotAutoProperty_ReachesGrandparentAutoProperty()
    {
        var source = @"
open class A {
    prop Tag int { get; init; }
}

open class B : A {
}

open class C : B {
    func Read() int {
        return base.Tag
    }
}

let c = C{Tag: 5}
c.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0127");
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void BaseDotAutoProperty_GetOnly_Write_DiagnosticGS0127()
    {
        // A getter-only auto-property has no setter, so writing it via base
        // remains a GS0127 (the access really is read-only here).
        var source = @"
open class BaseFile {
    prop Tag int { get; }
}

open class DashFile : BaseFile {
    func Set(v int) {
        base.Tag = v
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0127");
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
