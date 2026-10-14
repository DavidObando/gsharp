// <copyright file="Issue1070FieldInitializerStaticTests.cs" company="GSharp">
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

/// Issue #1070: a static member of a type (a `const`, or a `shared`
/// field) must be visible from a field-initializer expression in the same type,
/// just like it already is from a method/constructor body. These binder tests
/// assert that such references no longer produce GS0125 ("Variable doesn't
/// exist") nor the cascading GS0159, that the resolution is order-independent,
/// and that genuine instance-member references are still rejected (GS0377).
open class Issue1070FieldInitializerStaticTests {
    @Fact
    func InstanceInitializer_ReferencingClassConst_NoGS0125OrGS0159() {
        const source = "package p\n" +
            "class C {\n" +
            "    private let buf []uint8 = System.GC.AllocateArray[uint8](BlockSize)\n" +
            "    const BlockSize int32 = 16\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func InstanceInitializer_ReferencingClassConst_OrderIndependent() {
        // The const is declared BEFORE the field initializer here; still resolves.
        const source = "package p\n" +
            "class C {\n" +
            "    const BlockSize int32 = 16\n" +
            "    private let buf []uint8 = System.GC.AllocateArray[uint8](BlockSize)\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func SharedFieldInitializer_ReferencingSiblingSharedField_NoGS0125() {
        const source = "package p\n" +
            "class C {\n" +
            "    shared {\n" +
            "        let Rates []int32 = []int32{1, 2, 3}\n" +
            "        let First int32 = Rates[0]\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func InstanceInitializer_ReferencingSharedField_NoGS0125() {
        const source = "package p\n" +
            "class C {\n" +
            "    shared { let S int32 = 7 }\n" +
            "    let x int32 = S\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func SharedFieldInitializer_ReferencingClassConst_NoGS0125() {
        const source = "package p\n" +
            "class C {\n" +
            "    const Factor int32 = 10\n" +
            "    shared { let Scaled int32 = Factor * 2 }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func InstanceInitializer_ReferencingInstanceMember_StillReportsGS0377() {
        const source = "package p\n" + "class C {\n" + "    let a int32 = 5\n" + "    let b int32 = a\n" + "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_ReferencingUndefinedName_StillReportsGS0125() {
        const source = "package p\n" + "class C {\n" + "    let b int32 = doesNotExist\n" + "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics.ToList()
        }
    }
}
