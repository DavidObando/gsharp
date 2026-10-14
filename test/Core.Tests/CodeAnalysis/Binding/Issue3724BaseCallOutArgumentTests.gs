// <copyright file="Issue3724BaseCallOutArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #3724: `base.M(..., out x)` did not bind. Both base-call paths
/// (`BindBaseClassCall` for a G# base, `TryBindBaseClrInstanceCall`
/// for an imported one) bound every argument with the plain expression binder,
/// which has no `ref`/`out` arm — the argument hit the GS0236 guard
/// and bound to an error, overload resolution then failed with GS0130/GS0384,
/// and the caller's own `out` parameter cascaded into GS0238.
///
/// Found in migrated `test/LanguageServer.Tests`, whose
/// `ThrowingDocumentContentService.TryGet` forwards to
/// `base.TryGet(key, out content)`.
open class Issue3724BaseCallOutArgumentTests {
    @Fact
    func BaseCall_ForwardsOutArgument() {
        let source = `
open class Store {
    open func TryGet(key string, out value string) bool {
        value = key + "!"
        return true
    }
}

class Logging() : Store {
    override func TryGet(key string, out value string) bool {
        return base.TryGet(key, out value)
    }
}

var s = Logging()
var ok = s.TryGet("a", out var found)
found
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("a!", result.Value)
    }

    @Fact
    func BaseCall_ForwardsInlineOutDeclaration() {
        let source = `
open class Store {
    open func TryGet(key string, out value string) bool {
        value = key + "!"
        return true
    }
}

class Logging() : Store {
    override func TryGet(key string, out value string) bool {
        let ok = base.TryGet(key, out var inner)
        value = inner + "?"
        return ok
    }
}

var s = Logging()
var ok = s.TryGet("a", out var found)
found
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("a!?", result.Value)
    }

    @Fact
    func BaseCall_ForwardsRefArgument() {
        let source = `
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
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(102, result.Value)
    }
}
