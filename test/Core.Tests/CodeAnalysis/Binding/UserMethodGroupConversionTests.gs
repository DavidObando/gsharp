// <copyright file="UserMethodGroupConversionTests.cs" company="GSharp">
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

/// ADR-0112: converting a user-defined type's `shared` (static) or instance
/// method to a delegate via a method group — the originally reported bug
/// (`Use(Box.Make)` -> GS0158, `Use(Make)` -> GS0125). Covers
/// `Type.M`, `expr.M`, bare implicit-`this`, bare shared, and
/// overloaded selection driven by the target delegate signature.
open class UserMethodGroupConversionTests {
    @Fact
    func StaticMethodGroup_ViaTypeName_BindsAndInvokes() {
        let result = Evaluate(`
package P

class Box {
    var tag int32
    shared {
        func Make() Box { return Box{ tag: 7 } }
    }
}

func Use(f () -> Box) int32 { return f().tag }

Use(Box.Make)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func InstanceMethodGroup_ViaReceiverExpression_CapturesReceiver() {
        let result = Evaluate(`
package P

class Counter {
    var n int32
    func Get() int32 { return n }
}

func Use(f () -> int32) int32 { return f() }

var c = Counter{ n: 42 }
Use(c.Get)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func BareSharedMethodGroup_InsideMethod_Binds() {
        let result = Evaluate(`
package P

class Factory {
    shared {
        func Make() int32 { return 5 }
    }

    func Build() int32 {
        var f () -> int32 = Make
        return f()
    }
}

var fac = Factory{}
fac.Build()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func BareInstanceMethodGroup_InsideMethod_CapturesThis() {
        let result = Evaluate(`
package P

class Widget {
    var value int32
    func Read() int32 { return value }

    func AsDelegate() int32 {
        var f () -> int32 = Read
        return f()
    }
}

var w = Widget{ value: 9 }
w.AsDelegate()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func OverloadedStaticMethodGroup_SelectsByTargetSignature() {
        let result = Evaluate(`
package P

class Maker {
    shared {
        func Make() int32 { return 1 }
        func Make(x int32) int32 { return x + 1 }
    }
}

func Use(f (int32) -> int32) int32 { return f(10) }

Use(Maker.Make)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func OverloadedInstanceMethodGroup_SelectsByTargetSignature() {
        let result = Evaluate(`
package P

class Adder {
    var bias int32
    func Add() int32 { return bias }
    func Add(x int32) int32 { return bias + x }
}

func Use(f (int32) -> int32) int32 { return f(4) }

var a = Adder{ bias: 100 }
Use(a.Add)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(104, result.Value)
    }

    @Fact
    func SharedFactory_RegisteredAsDelegate_RunsThroughCollection() {
        // Faithful shape of the originally failing Oahu RootCommand pattern: a
        // command type exposes a `shared` factory whose method group is handed to
        // a registrar expecting a delegate, then invoked indirectly.
        let result = Evaluate(`
package P

class BuildCommand {
    var name string
    shared {
        func Create() BuildCommand { return BuildCommand{ name: "build" } }
    }
}

func Register(factory () -> BuildCommand) string {
    var cmd = factory()
    return cmd.name
}

Register(BuildCommand.Create)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("build", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
