// <copyright file="Issue3489StaticStoreReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3489: a bare <c>shared</c> field or property used as the base
/// receiver of a member STORE (<c>Instance.flush = value</c>) crashed the
/// emitter with GS9998 ("no local slot or parameter index") — the implicit
/// static variable symbols never got the expression-receiver synthesis the
/// instance shapes received in #689/#1446, while reads, call receivers, and
/// direct writes to the member itself all emitted fine.
/// </summary>
public class Issue3489StaticStoreReceiverTests
{
    [Fact]
    public void SharedFieldReceiver_MemberFieldStore_EmitsAndRuns()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SharedFieldReceiver_MemberPropertyStore_EmitsAndRuns()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SharedFieldReceiver_InSetAccessor_EmitsAndRuns()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SharedPropertyReceiver_MemberStore_EmitsAndRuns()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void SharedFieldReceiver_CompoundMemberStore_EmitsAndRuns()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }
}
