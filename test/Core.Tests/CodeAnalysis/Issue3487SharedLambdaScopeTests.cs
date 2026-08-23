// <copyright file="Issue3487SharedLambdaScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3487: a bare reference to a sibling <c>shared</c> member from a
/// lambda body inside a <c>shared</c> method failed name lookup (GS0130),
/// while the identical reference bound fine from the shared method body
/// itself, from instance-method lambdas, and via the qualified spelling.
/// Implicit static-self dispatch now falls back to the lambda's
/// <c>LexicalEnclosingType</c> when its synthetic symbol has no
/// <c>StaticOwnerType</c>.
/// </summary>
public class Issue3487SharedLambdaScopeTests
{
    [Fact]
    public void SharedMethodLambda_BareSiblingSharedCall_BindsAndRuns()
    {
        var source = @"
class E {
    shared {
        func Shown() int32 -> 4

        func FromShared() int32 {
            let f = () -> Shown()
            return f()
        }
    }
}

E.FromShared()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void SharedMethodLambda_BarePrivateSiblingSharedCall_BindsAndRuns()
    {
        var source = @"
class E {
    shared {
        private func Hidden() int32 -> 3

        func FromShared() int32 {
            let f = () -> Hidden()
            return f()
        }
    }
}

E.FromShared()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void SharedMethodLambda_TargetTypedBinding_BindsAndRuns()
    {
        var source = @"
class E {
    shared {
        func Shown() int32 -> 4

        func Run() int32 {
            let g () -> int32 = () -> Shown()
            return g()
        }
    }
}

E.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void SharedMethodNestedLambda_BareSiblingSharedCall_BindsAndRuns()
    {
        var source = @"
class E {
    shared {
        func Shown() int32 -> 4

        func Run() int32 {
            let outer = () -> {
                let inner = () -> Shown()
                return inner()
            }
            return outer()
        }
    }
}

E.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void InstanceMethodLambda_BareSiblingSharedCall_StillBindsAndRuns()
    {
        var source = @"
class E {
    shared {
        private func Hidden() int32 -> 3
    }

    func FromInstance() int32 {
        let f = () -> Hidden()
        return f()
    }
}

var e = E{}
e.FromInstance()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void StaticInterfaceHelperLambda_BareSiblingStaticCall_Binds()
    {
        var source = @"
struct S {
    shared {
        func Pick() int32 -> 9

        func Run() int32 {
            let f = () -> Pick()
            return f()
        }
    }
}

S.Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(9, result.Value);
    }
}
