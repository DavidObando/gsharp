// <copyright file="Issue3490OutVarRebindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3490: a bare call to a sibling `shared` function whose
/// argument subtree carries an inline `out var` declaration reported
/// GS9002 + GS0102 for the same declaration — BindCallExpression pre-binds
/// every argument for overload probing (declaring the out local), then the
/// implicit static-self finalizer re-binds the whole call from syntax and
/// the second declaration collided. A same-syntax collision now reuses the
/// already-declared local; genuinely duplicate declarations (distinct
/// syntax) still report GS0102.
open class Issue3490OutVarRebindTests {
    @Fact
    func BareSiblingCall_OutVarInIfExpressionArgument_BindsAndRuns() {
        let source = `
class W {
    shared {
        private func Format(value int32) string -> "v" + value.ToString()

        func Run() string {
            return Format(if int.TryParse("42", out var v) { v } else { 0 })
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("v42", result.Value)
    }

    @Fact
    func BareSiblingCall_OutVarUsedAfterCall_BindsAndRuns() {
        let source = `
class W {
    shared {
        private func Touch(flag bool) bool -> flag

        func Run() int32 {
            if Touch(int.TryParse("7", out var v)) {
                return v
            }
            return 0
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(7, result.Value)
    }

    @Fact
    func GenuineDuplicateOutVar_StillReportsAlreadyDeclared() {
        let source = `
class W {
    func Bad(text string) int32 {
        if int.TryParse(text, out var v) && int.TryParse(text, out var v) {
            return v
        }
        return 0
    }
}
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func QualifiedSiblingCall_OutVarArgument_StillBindsAndRuns() {
        let source = `
class W {
    shared {
        private func Format(value int32) string -> "v" + value.ToString()

        func Run() string {
            return W.Format(if int.TryParse("3", out var v) { v } else { 0 })
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("v3", result.Value)
    }
}
