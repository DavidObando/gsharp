// <copyright file="Issue1268StaticVirtualGenericInterfaceTests.cs" company="GSharp">
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

/// ADR-0089 / issue #1268 — static-virtual interface members accessed through a
/// type parameter (`T.Member`) whose constraint is a *constructed generic*
/// interface (`T : IData[int32]` or the self-referential
/// `T : IData[T]`). Prior issues (#755/#865/#1019/#1030/#1031) implemented
/// the feature for non-generic interface constraints; the generic-constraint
/// case reported GS0333 for properties (the constructed-interface property slot
/// was never searched). These tests pin that the binder now resolves both
/// static-virtual properties and methods through a generic interface
/// constraint.
open class Issue1268StaticVirtualGenericInterfaceTests {
    @Fact
    func StaticVirtualProperty_ThroughGenericConstraint_Binds() {
        let source = `
package p
interface IData[X] {
  shared {
    prop SizeInBytes int32 { get; }
  }
}
func Use[T IData[int32]]() int32 { return T.SizeInBytes }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func StaticVirtualProperty_ThroughSelfReferentialConstraint_Binds() {
        let source = `
package p
interface IData[TData IData[TData]] {
  shared {
    prop SizeInBytes int32 { get; }
  }
}
func Use[T IData[T]]() int32 { return T.SizeInBytes }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GetSetStaticVirtualProperty_ThroughSelfReferentialConstraint_Binds() {
        let source = `
package p
interface IData[TData IData[TData]] {
  shared {
    prop Tag int32 { get; set }
  }
}
func Use[T IData[T]]() int32 { return T.Tag }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func StaticVirtualMethod_ThroughGenericConstraint_Binds() {
        let source = `
package p
interface IData[X] {
  shared {
    func Size() int32;
  }
}
func Use[T IData[int32]]() int32 { return T.Size() }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func StaticVirtualMethod_ThroughSelfReferentialConstraint_Binds() {
        let source = `
package p
interface IData[TData IData[TData]] {
  shared {
    func Size() int32;
  }
}
func Use[T IData[T]]() int32 { return T.Size() }
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UnknownStaticVirtualMember_ThroughGenericConstraint_StillReportsGS0333() {
        let source = `
package p
interface IData[X] {
  shared {
    prop SizeInBytes int32 { get; }
  }
}
func Use[T IData[int32]]() int32 { return T.Missing }
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0333")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
