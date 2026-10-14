// <copyright file="Issue3487SharedLambdaScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3487: a bare reference to a sibling `shared` member from a
/// lambda body inside a `shared` method failed name lookup (GS0130),
/// while the identical reference bound fine from the shared method body
/// itself, from instance-method lambdas, and via the qualified spelling.
/// Implicit static-self dispatch now falls back to the lambda's
/// `LexicalEnclosingType` when its synthetic symbol has no
/// `StaticOwnerType`.
open class Issue3487SharedLambdaScopeTests {
    @Fact
    func SharedMethodLambda_BareSiblingSharedCall_BindsAndRuns() {
        let source = `
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
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(4, result.Value)
    }

    @Fact
    func SharedMethodLambda_BarePrivateSiblingSharedCall_BindsAndRuns() {
        let source = `
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
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(3, result.Value)
    }

    @Fact
    func SharedMethodLambda_TargetTypedBinding_BindsAndRuns() {
        let source = `
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
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(4, result.Value)
    }

    @Fact
    func SharedMethodNestedLambda_BareSiblingSharedCall_BindsAndRuns() {
        let source = `
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
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(4, result.Value)
    }

    @Fact
    func InstanceMethodLambda_BareSiblingSharedCall_StillBindsAndRuns() {
        let source = `
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
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(3, result.Value)
    }

    @Fact
    func StaticInterfaceHelperLambda_BareSiblingStaticCall_Binds() {
        let source = `
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
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(9, result.Value)
    }
}
