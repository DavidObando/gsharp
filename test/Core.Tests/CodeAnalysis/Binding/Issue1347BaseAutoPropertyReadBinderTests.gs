// <copyright file="Issue1347BaseAutoPropertyReadBinderTests.cs" company="GSharp">
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

/// Issue #1347: Emitted-oracle coverage for base auto property read.
/// Traceability: issue #1104; diagnostic GS0127.
open class Issue1347BaseAutoPropertyReadBinderTests {
    @Fact
    func BaseDotAutoProperty_InitOnly_Read_BindsWithoutGS0127() {
        let source = `
open class BaseFile {
    prop Tag int { get; init; }
}

open class DashFile : BaseFile {
    func Read() int {
        return base.Tag
    }
}

let d = DashFile{Tag: 42}
d.Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
        Assert.Equal(42, result.Value)
    }

    @Fact
    func BaseDotAutoProperty_ExpressionBodiedReExposure_BindsWithoutGS0127() {
        // The Oahu.Decrypt DashFile shape: an expression-bodied derived member
        // re-exposing the base auto-property (`prop Mirror T -> base.Tag`).
        let source = `
open class BaseFile {
    prop Tag int { get; init; }
}

open class DashFile : BaseFile {
    prop Mirror int -> base.Tag
}

let d = DashFile{Tag: 7}
d.Mirror
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
        Assert.Equal(7, result.Value)
    }

    @Fact
    func BaseDotAutoProperty_GetSet_ReadAndWrite_RoundTrips() {
        let source = `
open class BaseFile {
    prop Tag int { get; set; }
}

open class DashFile : BaseFile {
    func Read() int {
        return base.Tag
    }
    func Write(v int) {
        base.Tag = v
    }
}

let d = DashFile{Tag: 1}
d.Write(99)
d.Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
        Assert.Equal(99, result.Value)
    }

    @Fact
    func BaseDotAutoProperty_ReachesGrandparentAutoProperty() {
        let source = `
open class A {
    prop Tag int { get; init; }
}

open class B : A {
}

open class C : B {
    func Read() int {
        return base.Tag
    }
}

let c = C{Tag: 5}
c.Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
        Assert.Equal(5, result.Value)
    }

    @Fact
    func BaseDotAutoProperty_GetOnly_Write_DiagnosticGS0127() {
        // A getter-only auto-property has no setter, so writing it via base
        // remains a GS0127 (the access really is read-only here).
        let source = `
open class BaseFile {
    prop Tag int { get; }
}

open class DashFile : BaseFile {
    func Set(v int) {
        base.Tag = v
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
