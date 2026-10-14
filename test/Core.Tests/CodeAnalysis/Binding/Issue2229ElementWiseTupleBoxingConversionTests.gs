// <copyright file="Issue2229ElementWiseTupleBoxingConversionTests.cs" company="GSharp">
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

/// Issue #2229: (cref:Issue1256ElementWiseTupleConversionTests) taught
/// `Conversion.Classify` to accept a tuple `(T1, …, Tn) -> (U1, …, Un)`
/// whenever each element `Ti -> Ui` has an implicit conversion, but the lifted
/// nullable-target arm (`T? -> U?`) only covered TWO cases: reference-typed
/// underlyings sharing a CLR representation (#1255) and value-typed
/// underlyings widening to another value type (#1236). A value-typed nullable
/// source boxing to a reference-like nullable target — e.g. `int32? -> object?`,
/// which is exactly what a `bool?`/`int32?` tuple element boxes to when
/// passed as `(string, object?)` — fell through to `Conversion.None`
/// even though the bare `int32 -> object` boxing conversion is implicit. This
/// left every tuple containing such an element unable to convert, surfacing as
/// GS0154 on the `params (string, object?)...` call in the reported repro.
open class Issue2229ElementWiseTupleBoxingConversionTests {
    @Fact
    func NullableInt32Element_To_NullableObjectElement_AsArgument_Binds() {
        let source = `
func Take(t (string, object?)) {}

func F(n int32?) { Take(("count", n)) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableBoolElement_To_NullableObjectElement_AsArgument_Binds() {
        let source = `
func Take(t (string, object?)) {}

func F(b bool?) { Take(("ok", b)) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ParamsTupleArray_MixedNullableValueElements_Binds() {
        // The exact repro from issue #2229: a `params (string, object?)[]`-style
        // variadic call site with tuple literals whose second element is a
        // different nullable value type per argument.
        let source = `
func Args(pairs ...(string, object?)) {}

func F(n int32?, b bool?) {
    Args(("count", n), ("ok", b))
}
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NonNullableInt32Element_To_NullableObjectElement_AsArgument_Binds() {
        let source = `
func Take(t (string, object?)) {}

func F(n int32) { Take(("count", n)) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NumericWideningElement_IntToLong_AsArgument_Binds() {
        let source = `
func Take(t (string, int64)) {}

func F(n int32) { Take(("count", n)) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NestedTupleElement_BoxingInnerElement_Binds() {
        let source = `
func Take(t (string, (string, object?))) {}

func F(n int32?) { Take(("outer", ("inner", n))) }
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NoConversion_NullableIntToNullableString_StillReportsError() {
        let source = `
func Take(t (string, string?)) {}

func F(n int32?) { Take(("count", n)) }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert") || d.Message.Contains("requires a value of type")
        )
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
