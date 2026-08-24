// <copyright file="RefKindParameterSitesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0060: binding-time tests for <c>ref</c>/<c>out</c>/<c>in</c> parameters at
/// the binder sites beyond free functions: struct instance methods, struct static
/// methods, interface members, class methods, named-delegate-type declarations,
/// constructors, and override / interface-implementation matching (GS0240).
/// </summary>
public class RefKindParameterSitesTests
{
    [Fact]
    public void StructInstanceMethod_RefParameter_BindsCleanly()
    {
        // ADR-0079 (issue #719): the canonical declaration site for owned-
        // type instance methods is the in-body form. Structs don't yet
        // accept in-body methods, so this exercises the receiver-clause
        // form and explicitly ignores the GS0314 warning it emits.
        var source = @"
struct Counter {
    var Value int32
}

func (c Counter) Add(ref delta int32) {
    delta = delta + 1
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void ClassStaticMethod_OutParameter_BindsCleanly()
    {
        // ADR-0017 / ADR-0024: static methods on classes live in a `shared { ... }` block.
        var source = @"
class MathHelper {
    shared {
        func TryDouble(input int32, out result int32) bool {
            result = input * 2
            return true
        }
    }
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void InterfaceMember_OutParameter_BindsCleanly()
    {
        var source = @"
interface IParser {
    func TryParse(text string, out result int32) bool;
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClassConstructor_RefParameter_BindsCleanly()
    {
        var source = @"
class Box {
    var Value int32

    init(seed int32, ref delta int32) {
        delta = delta + 1
        Value = seed + delta
    }
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NamedDelegate_RefOutInParameters_BindsCleanly()
    {
        var source = @"
delegate IntRefAction(ref counter int32, by int32);
delegate IntOutPredicate(out result int32) bool;
delegate StructInObserver(in box int32);
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NamedDelegate_RefKindInvocationMismatches_ReportGS0235NotGS0155()
    {
        var sources = new[]
        {
            @"
package RefDelegateMismatch

delegate RefAction(ref value int32);
var callback RefAction = (ref value int32) -> { }
var value = 0
callback(out value)
0
",
            @"
package GenericOutDelegateMismatch

delegate OutAction[T](out value T) bool;
func Bad[T](callback OutAction[T], ref value T) {
    callback(ref value)
}
0
",
            @"
package GenericInDelegateMismatch

delegate InAction[T](in value T) bool;
func Bad[T](callback InAction[T], ref value T) {
    callback(ref value)
}
0
",
        };

        foreach (var source in sources)
        {
            var result = Evaluate(source);
            Assert.True(
                result.Diagnostics.Any(d => d.Id == "GS0235"),
                source + "\n" + string.Join("\n", result.Diagnostics.Select(d => $"{d.Id}: {d.Message}")));
            Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0155");
        }

        var missingIn = Evaluate(@"
package InDelegateMissingModifier

delegate InAction(in value int32);
var callback InAction = (in value int32) -> { }
var value = 0
callback(value)
0
");
        Assert.Contains(missingIn.Diagnostics, d => d.Id == "GS0242");
        Assert.DoesNotContain(missingIn.Diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void PrimaryCtor_RefParameter_Rejected()
    {
        var source = @"
class Vec(ref x int32) { }
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0424");
    }

    // ----------------------------------------------------------------------
    // Override / interface-implementation ref-kind matching (GS0240).
    // ----------------------------------------------------------------------

    [Fact]
    public void Override_AddsRefWhereBaseHasNone_ReportsGS0240()
    {
        var source = @"
open class Base {
    open func Adjust(value int32) {
    }
}

class Derived : Base {
    override func Adjust(ref value int32) {
        value = value + 1
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0240");
    }

    [Fact]
    public void Override_RemovesRef_ReportsGS0240()
    {
        var source = @"
open class Base {
    open func Adjust(ref value int32) {
        value = value + 1
    }
}

class Derived : Base {
    override func Adjust(value int32) {
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0240");
    }

    [Fact]
    public void Override_ChangesInToRef_ReportsGS0240()
    {
        var source = @"
open class Base {
    open func Observe(in value int32) {
    }
}

class Derived : Base {
    override func Observe(ref value int32) {
        value = value + 1
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0240");
    }

    [Fact]
    public void Override_ChangesOutToIn_ReportsGS0240()
    {
        var source = @"
open class Base {
    open func Produce(out value int32) {
        value = 0
    }
}

class Derived : Base {
    override func Produce(in value int32) {
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0240");
    }

    [Fact]
    public void Override_MatchingRefKind_BindsCleanly()
    {
        var source = @"
open class Base {
    open func Adjust(ref value int32) {
        value = value + 1
    }
}

class Derived : Base {
    override func Adjust(ref value int32) {
        value = value + 2
    }
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void InterfaceImpl_MissingOutOnImplementor_ReportsGS0240()
    {
        var source = @"
interface IParser {
    func TryParse(text string, out result int32) bool;
}

class MyParser : IParser {
    func TryParse(text string, result int32) bool {
        return false
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0240");
    }

    [Fact]
    public void InterfaceImpl_MatchingOut_BindsCleanly()
    {
        var source = @"
interface IParser {
    func TryParse(text string, out result int32) bool;
}

class MyParser : IParser {
    func TryParse(text string, out result int32) bool {
        result = 0
        return false
    }
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
