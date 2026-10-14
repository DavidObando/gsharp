// <copyright file="Issue2171NullableIsInterfaceNarrowingTests.cs" company="GSharp">
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

/// Issue #2171 (follow-up to #2165) — `is`-pattern smart-cast narrowing to
/// an INTERFACE must also take effect when the operand's static type is a
/// NULLABLE type parameter (`T?`) or a nullable interface (`IShape?`),
/// not only the non-nullable forms fixed by #2165. Stripping the nullable
/// wrapper before applying the type-parameter/interface rule makes `T?`
/// behave like `T` (and `IShape?` like `IShape`), so
/// `if x is IInit` narrows `x` to `IInit` and `x.Init()`
/// resolves.
open class Issue2171NullableIsInterfaceNarrowingTests {
    @Fact
    func If_IsInterface_OnNullableTypeParameterOperand_NarrowsToTestedInterface() {
        // Declared type is a NULLABLE unconstrained type parameter (`T?`).
        let result = Evaluate(`
interface IInit {
    func Init() void;
}
func Run[T](x T?) void {
    if x is IInit {
        x.Init()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsInterface_OnNullableInterfaceOperand_NarrowsToTestedInterface() {
        // Declared type is a NULLABLE (unrelated) interface (`IShape?`).
        let result = Evaluate(`
interface IInit {
    func Init() void;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape?) void {
    if x is IInit {
        x.Init()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func And_IsInterface_OnNullableTypeParameterOperand_NarrowsRightOperand() {
        // The short-circuit (`x is I && …`) classifier must agree with the
        // `if`-statement classifier for nullable type-parameter operands.
        let result = Evaluate(`
interface IInit {
    func Init() int32;
}
func Run[T](x T?) bool {
    return x is IInit && x.Init() > 0
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func And_IsInterface_OnNullableInterfaceOperand_NarrowsRightOperand() {
        let result = Evaluate(`
interface IInit {
    func Init() int32;
}
interface IShape {
    func Area() int32;
}
func Run(x IShape?) bool {
    return x is IInit && x.Init() > 0
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsInterface_OnNonNullableTypeParameterOperand_StillNarrows() {
        // Control: the non-nullable type-parameter operand case fixed by #2165
        // must keep working.
        let result = Evaluate(`
interface IInit {
    func Init() void;
}
func Run[T](x T) void {
    if x is IInit {
        x.Init()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsInterface_OnNullableObjectOperand_StillNarrows() {
        // Control: the pre-existing `object?` operand case must keep working.
        let result = Evaluate(`
interface IInit {
    func Init() void;
}
func Run(x object?) void {
    if x is IInit {
        x.Init()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
