// <copyright file="Issue3724BaseCallOutArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3724: <c>base.M(..., out x)</c> did not bind. Both base-call paths
/// (<c>BindBaseClassCall</c> for a G# base, <c>TryBindBaseClrInstanceCall</c>
/// for an imported one) bound every argument with the plain expression binder,
/// which has no <c>ref</c>/<c>out</c> arm — the argument hit the GS0236 guard
/// and bound to an error, overload resolution then failed with GS0130/GS0384,
/// and the caller's own <c>out</c> parameter cascaded into GS0238.
///
/// Found in migrated <c>test/LanguageServer.Tests</c>, whose
/// <c>ThrowingDocumentContentService.TryGet</c> forwards to
/// <c>base.TryGet(key, out content)</c>.
/// </summary>
public class Issue3724BaseCallOutArgumentTests
{
    [Fact]
    public void BaseCall_ForwardsOutArgument()
    {
        var source = @"
open class Store {
    open func TryGet(key string, out value string) bool {
        value = key + ""!""
        return true
    }
}

class Logging() : Store {
    override func TryGet(key string, out value string) bool {
        return base.TryGet(key, out value)
    }
}

var s = Logging()
var ok = s.TryGet(""a"", out var found)
found
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("a!", result.Value);
    }

    [Fact]
    public void BaseCall_ForwardsInlineOutDeclaration()
    {
        var source = @"
open class Store {
    open func TryGet(key string, out value string) bool {
        value = key + ""!""
        return true
    }
}

class Logging() : Store {
    override func TryGet(key string, out value string) bool {
        let ok = base.TryGet(key, out var inner)
        value = inner + ""?""
        return ok
    }
}

var s = Logging()
var ok = s.TryGet(""a"", out var found)
found
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("a!?", result.Value);
    }

    [Fact]
    public void BaseCall_ForwardsRefArgument()
    {
        var source = @"
open class Store {
    open func Bump(ref value int32) int32 {
        value = value + 1
        return value
    }
}

class Logging() : Store {
    override func Bump(ref value int32) int32 {
        return base.Bump(ref value) + 100
    }
}

var s = Logging()
var n = 1
s.Bump(ref n)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(102, result.Value);
    }
}
