// <copyright file="Issue3489StaticStoreReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3489: a bare `shared` field or property used as the base
/// receiver of a member STORE (`Instance.flush = value`) crashed the
/// emitter with GS9998 ("no local slot or parameter index") — the implicit
/// static variable symbols never got the expression-receiver synthesis the
/// instance shapes received in #689/#1446, while reads, call receivers, and
/// direct writes to the member itself all emitted fine.
open class Issue3489StaticStoreReceiverTests {
    @Fact
    func SharedFieldReceiver_MemberFieldStore_EmitsAndRuns() {
        let source = `
class Logging {
    var flush bool

    shared {
        var Instance Logging = Logging{}

        func SetFlush(value bool) {
            Instance.flush = value
        }

        func Read() bool -> Instance.flush
    }
}

Logging.SetFlush(true)
Logging.Read()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(true, result.Value)
    }

    @Fact
    func SharedFieldReceiver_MemberPropertyStore_EmitsAndRuns() {
        let source = `
class Logging {
    var flush bool

    prop Flag bool {
        get -> this.flush
        set {
            this.flush = value
        }
    }

    shared {
        var Instance Logging = Logging{}

        func PropStore(v bool) {
            Instance.Flag = v
        }

        func Read() bool -> Instance.flush
    }
}

Logging.PropStore(true)
Logging.Read()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(true, result.Value)
    }

    @Fact
    func SharedFieldReceiver_InSetAccessor_EmitsAndRuns() {
        let source = `
class Logging {
    var flush bool

    shared {
        var Instance Logging = Logging{}

        prop InstantFlush bool {
            get -> Instance.flush
            set -> Instance.flush = value
        }
    }
}

Logging.InstantFlush = true
Logging.InstantFlush
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(true, result.Value)
    }

    @Fact
    func SharedPropertyReceiver_MemberStore_EmitsAndRuns() {
        let source = `
class Logging {
    var count int32

    shared {
        var backing Logging = Logging{}

        prop Instance Logging {
            get -> backing
        }

        func Bump() int32 {
            Instance.count = Instance.count + 1
            return Instance.count
        }
    }
}

Logging.Bump()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    @Fact
    func SharedFieldReceiver_CompoundMemberStore_EmitsAndRuns() {
        let source = `
class Counter {
    var total int32

    shared {
        var Instance Counter = Counter{}

        func Add(v int32) int32 {
            Instance.total += v
            return Instance.total
        }
    }
}

Counter.Add(21)
Counter.Add(21)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }
}
