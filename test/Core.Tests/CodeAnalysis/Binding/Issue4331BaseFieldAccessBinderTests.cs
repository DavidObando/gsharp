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
    public void BaseField_NearerFieldBeatsFartherProperty_ReadAndWrite()
    {
        // Copilot review, PR #4334: TryGetProperty walks searchBase's ENTIRE
        // ancestor chain before ever returning false, so nesting the field
        // fallback inside `!TryGetProperty(...)` let a same-named PROPERTY on
        // a DISTANT ancestor (Grandparent) win over a FIELD the IMMEDIATE
        // base (Parent, i.e. searchBase itself) declares -- the opposite of
        // the field-before-property precedence the ordinary (non-`base.`)
        // lookup already follows (ExpressionBinder.Access.MemberLookup.cs).
        // `base.X` from Derived must resolve to Parent's FIELD, never
        // Grandparent's property.
        var source = @"
import System

open class Grandparent {
    var backing int32 = 111
    prop X int32 {
        get -> backing
        set { backing = value }
    }
}

open class Parent : Grandparent {
    protected var X int32 = 1
}

class Derived : Parent {
    func RoundTrip() int32 {
        base.X = 42
        return base.X
    }

    // ADR-0091/#1104's explicit base-selector form independently probes
    // Grandparent's PROPERTY specifically (bypassing the nearest-base
    // resolution `base.X` uses), so this must stay at its untouched initial
    // value -- proving `base.X` above never went anywhere near it.
    func GrandparentPropertyValue() int32 -> base[Grandparent].X
}

var d = Derived{}
Console.WriteLine(d.RoundTrip())
Console.WriteLine(d.GrandparentPropertyValue())
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));

        // `base.X` must resolve to Parent's FIELD (round-trips to 42) while
        // Grandparent's PROPERTY (backed by `backing`) stays completely
        // untouched at its initial value 111 -- if this ever regresses back
        // to resolving `base.X` against Grandparent's property instead, this
        // second line would read 42, not 111.
        Assert.Equal(
            "42" + System.Environment.NewLine + "111" + System.Environment.NewLine,
            result.Output);
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
