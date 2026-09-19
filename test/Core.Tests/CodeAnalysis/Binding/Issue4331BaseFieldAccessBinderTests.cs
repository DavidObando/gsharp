// <copyright file="Issue4331BaseFieldAccessBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4331: <c>base.fieldName</c> (read) and <c>base.fieldName = value</c>
/// (write) had no G# spelling for an inherited FIELD — issue #986 gave
/// <c>base.M(...)</c> a spelling for inherited methods, and #1104 extended
/// the plain/bracketed forms to inherited PROPERTIES, but neither covered a
/// plain field. Mirrors <see cref="Issue1260BaseBclCallBinderTests"/>'s shape
/// (an imported CLR base) and adds the GSharp-native-open-base-class case,
/// which shares the exact same binder path since a field is never virtually
/// dispatched.
/// </summary>
public class Issue4331BaseFieldAccessBinderTests
{
    [Fact]
    public void BaseField_ReadAndWrite_IntoClrImportedBase_BindsCleanAndRunsCorrectly()
    {
        // System.Text.RegularExpressions.Regex has a real `protected string?
        // pattern` field — the exact shape surfaced by wiring gsgen to run the
        // real [GeneratedRegex] generator (ADR-0143 §B / ADR-0145): its
        // emitted matcher reads/writes inherited RegexRunner protected fields
        // via `base.`.
        var source = @"
import System
import System.Text.RegularExpressions

class MyRegex : Regex {
    func DescribePattern() string? {
        var p = base.pattern
        base.pattern = p + ""!""
        return base.pattern
    }
}

var r = MyRegex{}
Console.WriteLine(r.DescribePattern())
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("!" + System.Environment.NewLine, result.Output);
    }

    [Fact]
    public void BaseField_ReadAndWrite_IntoGSharpNativeOpenBase_BindsCleanAndRunsCorrectly()
    {
        var source = @"
import System

open class GsBase {
    protected var counter int32 = 10
}

class GsDerived : GsBase {
    func Bump() int32 {
        var v = base.counter
        base.counter = v + 5
        return base.counter
    }
}

var d = GsDerived{}
Console.WriteLine(d.Bump())
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("15" + System.Environment.NewLine, result.Output);
    }

    [Fact]
    public void BaseField_UnrelatedName_StillDiagnosticGS0384()
    {
        // Regression guard: the new field fallback must not swallow a
        // genuinely unresolvable `base.` member — issue #986's GS0384 still
        // fires for a name the base declares nothing by, at all.
        var source = @"
import System.Text.RegularExpressions

class MyRegex : Regex {
    func F() {
        var x = base.notARealMemberAtAll
    }
}
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0384");
    }
}
