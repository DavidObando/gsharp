// <copyright file="Issue1100GenericMethodUserTypeArgTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #1100 (binding facet): a generic method invoked on a constructed BCL
/// generic receiver whose type argument is a same-compilation user type must
/// recover the symbolic substituted result type instead of erasing it to
/// `object`. For `Queue[Entry]` (with `Entry` declared in the
/// same compilation), `q.Dequeue()` must bind to `Entry` so that an
/// `Entry`-typed target assigns without `GS0155`, and
/// `q.Enqueue(e)` must accept an `Entry` argument.
open class Issue1100GenericMethodUserTypeArgTests {
    @Fact
    func Dequeue_OnQueueOfUserType_BindsToUserType_NotObject() {
        // Before the fix the generic method return type T erased to `object`,
        // so assigning `q.Dequeue()` to an `Entry`-typed local reported GS0155
        // ("Cannot convert type 'object' to 'Entry'").
        let source = `
import System.Collections.Generic

class Entry { }

class C {
    let q Queue[Entry] = Queue[Entry]()

    func drain() {
        let x Entry = q.Dequeue()
    }
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("GS0155"))
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Enqueue_OnQueueOfUserType_AcceptsUserTypeArgument() {
        // The by-T parameter of Enqueue must accept an `Entry` argument rather
        // than erasing to `object` and rejecting the call.
        let source = `
import System.Collections.Generic

class Entry { }

class C {
    let q Queue[Entry] = Queue[Entry]()

    func add(e Entry) {
        q.Enqueue(e)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func EnqueueDequeueCount_RoundTrip_OnQueueOfUserType_Binds() {
        // Full round trip exercising Enqueue (by-T parameter), Count, and
        // Dequeue (T return) on a same-compilation user type argument.
        let source = `
import System.Collections.Generic

class Entry {
    var Value int32
}

class C {
    let q Queue[Entry] = Queue[Entry]()

    func add(e Entry) {
        q.Enqueue(e)
    }

    func drainSum() int32 {
        var total = 0
        while q.Count > 0 {
            let x = q.Dequeue()
            total = total + x.Value
        }
        return total
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
