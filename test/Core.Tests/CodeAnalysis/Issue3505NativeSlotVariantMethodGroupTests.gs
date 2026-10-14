// <copyright file="Issue3505NativeSlotVariantMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3505: reference-variant method groups bind AT native
/// function-type slots — the resolved group is built at the target type, so
/// the emitter creates the target-typed delegate directly over the method
/// (plain ldftn+newobj) instead of hitting the unsupported
/// delegate-to-delegate variance conversion. Value-type variance — which
/// CLR delegate variance cannot honor and which used to compile and then
/// NRE — is rejected at bind time, for method groups and literals alike.
open class Issue3505NativeSlotVariantMethodGroupTests {
    @Fact
    func ContravariantParameter_MethodGroupIntoNativeSlot_BindsAndRuns() {
        let source = `
class Cell {
}

class W {
    shared {
        func Describe(value object) string {
            return value.GetType().Name
        }

        func Apply(cell Cell, f (Cell) -> object) object {
            return f(cell)
        }

        func Run() object {
            return Apply(Cell(), Describe)
        }
    }
}

W.Run().ToString()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("Cell", result.Value)
    }

    @Fact
    func CovariantReturn_MethodGroupIntoNativeSlot_BindsAndRuns() {
        let source = `
class W {
    shared {
        func Name(value string) string {
            return value + "!"
        }

        func Apply(value string, f (string) -> object) object {
            return f(value)
        }

        func Run() object {
            return Apply("hi", Name)
        }
    }
}

W.Run().ToString()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("hi!", result.Value)
    }

    @Fact
    func VariantGroup_AssignedToNativeTypedLocal_BindsAndRuns() {
        let source = `
class Cell {
}

class W {
    shared {
        func Describe(value object) string {
            return value.GetType().Name
        }

        func Run() object {
            let f ((Cell) -> object) = Describe
            return f(Cell())
        }
    }
}

W.Run().ToString()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("Cell", result.Value)
    }

    @Fact
    func ValueTypeVariance_MethodGroup_IsRejectedAtBindTime() {
        // Used to compile and NRE at runtime — CLR delegate variance cannot
        // box the int32 argument.
        let source = `
class W {
    shared {
        func Describe(value object) string {
            return value.GetType().Name
        }

        func Apply(cell int32, f (int32) -> object) object {
            return f(cell)
        }

        func Run() object {
            return Apply(3, Describe)
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError && (d.Id == "GS0218" || d.Id == "GS0154"))
    }

    @Fact
    func ValueTypeVariance_FunctionValue_IsRejectedAtBindTime() {
        let source = `
class W {
    shared {
        func Apply(cell int32, f (int32) -> object) object {
            return f(cell)
        }

        func Run() object {
            let g = func(value object) string {
                return value.GetType().Name
            }
            return Apply(3, g)
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError && d.Id == "GS0154")
    }

    @Fact
    func ExactMatch_MethodGroupIntoNativeSlot_StillBinds() {
        let source = `
class W {
    shared {
        func Double(value int32) int32 {
            return value * 2
        }

        func Apply(value int32, f (int32) -> int32) int32 {
            return f(value)
        }

        func Run() int32 {
            return Apply(21, Double)
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }
}
