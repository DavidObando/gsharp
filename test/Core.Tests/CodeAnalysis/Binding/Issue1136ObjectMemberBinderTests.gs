// <copyright file="Issue1136ObjectMemberBinderTests.cs" company="GSharp">
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

/// Issue #1136: Emitted-oracle coverage for object member.
open class Issue1136ObjectMemberBinderTests {
    @Fact
    func ThisReceiver_ObjectMembers_BindWithCorrectTypes_OnClass() {
        let source = `
import System
class C {
    func F() int32 {
        let h int32 = this.GetHashCode()
        let s string? = this.ToString()
        let t Type = this.GetType()
        let e bool = this.Equals(this)
        return h
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func LocalReceiver_ObjectMembers_BindOnClassInstance() {
        let source = `
import System
class C { }
class D {
    func F() string? {
        let c = C{ }
        let t Type = c.GetType()
        let s string? = c.ToString()
        return s
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func BareImplicitThis_GetType_ResolvesAsThisGetType() {
        let source = `
class C {
    func F() string {
        return GetType().Name
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func StructReceiver_GetHashCode_BindsOnValueType() {
        let source = `
struct S { let X int32 }
class C {
    func F() int32 {
        let s = S{ X: 1 }
        return s.GetHashCode()
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func StructReceiver_ObjectMembers_BindWithCorrectTypes() {
        let source = `
import System
struct S { let X int32 }
class C {
    func F() int32 {
        let a = S{ X: 1 }
        let b = S{ X: 1 }
        let h int32 = a.GetHashCode()
        let s string? = a.ToString()
        let t Type = a.GetType()
        let e bool = a.Equals(b)
        return h
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func UnknownMethod_StillReportsGS0159() {
        let source = `
class C {
    func F() {
        let x = this.NoSuchMethod()
    }
}
`
        let diagnostics = Evaluate(source).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("NoSuchMethod"))
    }

    @Fact
    func UserToStringOverride_TakesPrecedenceOverInheritedMember() {
        // A user-declared `func ToString() string` must win over the inherited
        // System.Object.ToString(); the emitted oracle executes the user method.
        let source = `
class C {
    func ToString() string { return "custom" }
}
let c = C{ }
c.ToString()
`
        let result = Evaluate(source)
        AssertNoErrors(result)
        Assert.Equal("custom", result.Value)
    }

    @Fact
    func ExplicitImportedBase_StillResolvesInheritedMembers() {
        // Control: a user class with an explicit imported CLR base must keep
        // resolving members against its actual base (and Object transitively).
        let source = `
import System
class MyErr : Exception {
    func F() int32 {
        let h int32 = this.GetHashCode()
        let s string = this.ToString()
        return h
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func MethodGroup_InheritedObjectMember_BindsOnClassReceiver() {
        // ADR-0112 method-group position: a bare `obj.ToString` (no call) on a
        // user class with no explicit imported base captures the inherited
        // System.Object.ToString as a CLR method group convertible to a delegate.
        let source = `
class C { }
func Use(f () -> string) string { return f() }
class D {
    func F() string {
        let c = C{ }
        let f () -> string = c.ToString
        return Use(f)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    shared {
        private func AssertNoErrors(result EmittedOracleResult) {
            Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
