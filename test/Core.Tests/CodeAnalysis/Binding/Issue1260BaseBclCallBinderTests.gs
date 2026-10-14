// <copyright file="Issue1260BaseBclCallBinderTests.cs" company="GSharp">
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

/// Issue #1260: Emitted-oracle coverage for base bcl call.
/// Traceability: diagnostic GS0413.
open class Issue1260BaseBclCallBinderTests {
    @Fact
    func BaseCall_IntoBclStream_BindsClean() {
        // Stream has unrelated abstract members; keep this fixture open so
        // the test isolates base-call binding.
        let source = `
import System.IO
open class MyStream : Stream {
    open func Dispose(disposing bool) {
        base.Dispose(disposing)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func BaseCall_ObjectToString_BindsClean_WhenDerivingOnlyFromObject() {
        // Issue #1354: object.ToString() is annotated to return string?, so the
        // override's declared return type must be string? to receive it.
        let source = `
class Greeter {
    open func ToString() string? { return base.ToString() }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func BaseCall_MultiLevel_UserBaseThenBcl_BindsClean() {
        let source = `
import System.IO
open class Wrapper : MemoryStream { }
class MyMem : Wrapper {
    open func Dispose(disposing bool) {
        base.Dispose(disposing)
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func BaseProperty_ReadAndWrite_IntoBclBase_BindsClean() {
        let source = `
import System.IO
class MyMem : MemoryStream {
    func RoundTrip() int64 {
        base.Position = 0
        return base.Position
    }
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func BaseCall_AbstractBclMember_DiagnosticGS0413() {
        let source = `
import System.IO
open class MyStream : Stream {
    open func TryRead(buffer []byte, offset int32, count int32) int32 {
        return base.Read(buffer, offset, count)
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0413")
    }

    @Fact
    func BaseCall_MemberNotOnBclBase_DiagnosticGS0384() {
        let source = `
import System.IO
class MyMem : MemoryStream {
    func F() {
        base.NotARealMember()
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0384")
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
