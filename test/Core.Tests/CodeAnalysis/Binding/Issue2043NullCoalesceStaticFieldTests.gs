// <copyright file="Issue2043NullCoalesceStaticFieldTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2043: a null-coalescing compound assignment (`??=`) targeting a
/// `shared{}` (static) field crashed the binder with a
/// (cref:System.NullReferenceException). (cref:StatementBinder.TryBuildNullCoalescingReadWrite)
/// unconditionally called `CaptureReceiver` on the bound field access's
/// `Receiver`, which is `null` for a static field (there is no
/// instance to spill into a synthetic local) — dereferencing
/// `receiver.Type` inside `CaptureReceiver` then NREd. The fix
/// mirrors the existing null-receiver handling already used for property
/// access (`propAccess.Receiver == null ? null : CaptureReceiver(...)`)
/// and for plain/compound (`+=`) assignment of static fields in
/// `ExpressionBinder.Assignments.cs`. These tests pin that a static
/// field `??=` now binds and evaluates cleanly (no crash, no spurious
/// diagnostics), and that the sibling instance-field case keeps working.
open class Issue2043NullCoalesceStaticFieldTests {
    @Fact
    func StaticField_NullCoalesceAssign_DoesNotThrowNRE() {
        // This is the primary regression test: prior to the fix, evaluating
        // this source threw a NullReferenceException out of the binder
        // (surfaced by gsc as GS9998) instead of returning a clean result.
        let source = `
class C {
  shared {
    var Field string? = nil
  }
}

C.Field ??= "default"
C.Field
`
        let exception = Record.Exception(
            func () object {
                return Evaluate(source)
            }
        )
        Assert.Null(exception)
    }

    @Fact
    func StaticField_NullCoalesceAssign_FiresWhenNil() {
        let source = `
class C {
  shared {
    var Field string? = nil
  }
}

C.Field ??= "default"
C.Field
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("default", result.Value)
    }

    @Fact
    func StaticField_NullCoalesceAssign_DoesNotFireWhenAlreadySet() {
        // Set the static field through a plain assignment first so this test
        // isolates ??= behavior from declaration-initializer behavior and
        // exercises a genuinely non-nil field.
        let source = `
class C {
  shared {
    var Field string? = nil
  }
}

C.Field = "already"
C.Field ??= "default"
C.Field
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("already", result.Value)
    }

    @Fact
    func InstanceField_NullCoalesceAssign_StillBindsAndEvaluates() {
        // Sibling instance-field case: makes sure the static-field fix does
        // not regress the (already-working) instance-receiver path, which
        // spills the instance receiver into a synthetic local via
        // CaptureReceiver.
        let source = `
class C {
  var Field string? = nil
}

var c C = C{}
c.Field ??= "default"
c.Field
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("default", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
