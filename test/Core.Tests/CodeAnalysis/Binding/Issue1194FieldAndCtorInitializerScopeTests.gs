// <copyright file="Issue1194FieldAndCtorInitializerScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1194: a field initializer and a constructor-initializer
/// (`: base(...)` / `: this(...)`) must be able to resolve unqualified
/// calls to top-level free functions and to the enclosing type's static members
/// (methods, consts, static fields), matching C#. These binder tests assert the
/// references no longer produce GS0130 ("Function doesn't exist") nor GS0125
/// ("Variable doesn't exist"), are order independent, and that genuine instance
/// member references from a field initializer are still rejected (GS0377).
open class Issue1194FieldAndCtorInitializerScopeTests {
    @Fact
    func FieldInitializer_CallingFreeFunction_NoGS0130() {
        const source = "package p\n" +
            "func GetName() string { return \"x\" }\n" +
            "class C {\n" +
            "    let Title string = GetName()\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0130")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func FieldInitializer_CallingSiblingStaticMethod_OrderIndependent_NoGS0130() {
        // The static method is declared AFTER the field initializer.
        const source = "package p\n" +
            "class C {\n" +
            "    shared {\n" +
            "        let Title string = GetName()\n" +
            "        private func GetName() string { return \"x\" }\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0130")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func BaseConstructorInitializer_ReferencingSiblingConst_NoGS0125() {
        const source = "package p\n" +
            "open class Base { init(x uint64) { } }\n" +
            "class Derived : Base {\n" +
            "    init() : base(Poly) { }\n" +
            "    shared { const Poly uint64 = 5UL }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0130")
    }

    @Fact
    func FieldInitializer_ReferencingInstanceMember_StillReportsGS0377() {
        // Instance members are genuinely unavailable in a field initializer
        // ('this' does not exist yet) — GS0377 must still fire.
        const source = "package p\n" + "class C {\n" + "    let A int32 = B\n" + "    let B int32 = 3\n" + "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics.ToList()
        }
    }
}
