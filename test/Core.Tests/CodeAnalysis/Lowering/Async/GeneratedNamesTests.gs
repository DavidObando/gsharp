// <copyright file="GeneratedNamesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Lowering.Async
import Xunit

/// Naming determinism of (cref:GeneratedNames). The exact strings
/// are part of the contract with the debugger and any decompiler/PDB
/// tooling, so changes here are intentional and visible.
open class GeneratedNamesTests {
    @Fact
    func Constants_MatchRoslynShape() {
        Assert.Equal("<>1__state", GeneratedNames.StateField)
        Assert.Equal("<>t__builder", GeneratedNames.BuilderField)
        Assert.Equal("<>4__this", GeneratedNames.ThisField)
    }

    @Fact
    func ParameterField_ManglesUserName() {
        Assert.Equal("<>3__url", GeneratedNames.ParameterField("url"))
    }

    @Fact
    func HoistedLocalField_IncludesOrdinal() {
        Assert.Equal("<x>5__1", GeneratedNames.HoistedLocalField("x", 1))
    }

    @Fact
    func AwaiterField_IncludesOrdinal() {
        Assert.Equal("<>u__2", GeneratedNames.AwaiterField(2))
    }

    @Fact
    func StateMachineTypeName_IncludesMethodNameAndOrdinal() {
        Assert.Equal("<Sum>d__0", GeneratedNames.StateMachineTypeName("Sum", 0))
    }
}
