// <copyright file="Issue3526ClassIsInterfaceNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3526 — the concrete-class residual of #2165/#2171: an <c>is
/// IInterface</c> test must smart-cast a receiver whose declared type is an
/// UNSEALED (<c>open</c>) concrete class, even when the class does not
/// statically implement the tested interface. A runtime value may be a
/// subclass that does implement it, so <c>if x is IInterface</c> narrows
/// <c>x</c> to <c>IInterface</c> (matching the pre-existing <c>object</c>
/// operand behaviour) and its members resolve. A sealed (non-<c>open</c>)
/// class has no such unknown subclass, so it must keep reporting GS0159.
/// </summary>
public class Issue3526ClassIsInterfaceNarrowingTests
{
    [Fact]
    public void If_IsImportedInterface_OnOpenClassOperand_NarrowsToTestedInterface()
    {
        // Repro from the issue: an `open class` receiver tested against the
        // imported `IDisposable` interface it does not statically implement.
        var result = EmittedOracle.Evaluate(@"
import System
open class Resource {
}
func DisposeIfNeeded(value Resource) bool {
    if value is IDisposable {
        value.Dispose()
        return true
    }
    return false
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsSourceInterface_OnOpenClassOperand_NarrowsToTestedInterface()
    {
        // The issue notes the same failure occurs with a source-declared G#
        // interface, so it is not specific to imported `IDisposable`.
        var result = EmittedOracle.Evaluate(@"
interface IInit {
    func Init() void;
}
open class Resource {
}
func Run(value Resource) void {
    if value is IInit {
        value.Init()
    }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsInterface_OnSealedClassOperand_StillReportsGS0159()
    {
        // Control: a non-`open` (sealed-by-default) class has no unknown
        // subclass that could implement the interface, so the member must
        // remain unresolved.
        var result = EmittedOracle.Evaluate(@"
import System
class Resource {
}
func DisposeIfNeeded(value Resource) bool {
    if value is IDisposable {
        value.Dispose()
        return true
    }
    return false
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Dispose"));
    }

    [Fact]
    public void And_IsInterface_OnOpenClassOperand_NarrowsRightOperand()
    {
        // The short-circuit (`x is I && …`) classifier must agree with the
        // `if`-statement classifier for open-class operands.
        var result = EmittedOracle.Evaluate(@"
import System
open class Resource {
}
func Run(value Resource) bool {
    return value is IDisposable && Run2(value)
}
func Run2(value IDisposable) bool {
    value.Dispose()
    return true
}
");

        Assert.Empty(result.Diagnostics);
    }
}
