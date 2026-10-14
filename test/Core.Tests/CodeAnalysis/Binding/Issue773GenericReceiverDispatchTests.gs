// <copyright file="Issue773GenericReceiverDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #773 / ADR-0084 §L2 follow-up. The binder must dispatch a
/// call site like `recv.M()` to a user-declared extension whose
/// receiver type contains a function-level type parameter — e.g.
/// `func (self sequence[T]) FirstOrNil[T]() T?` or
/// `func (self IEnumerable[T]) MyFirst[T any](fb T) T`.
///
/// Prior to the fix, (cref:BoundScope.TryLookupExtensionFunction)
/// matched extensions by reference-equality on the receiver type, so an
/// extension declared with an open generic receiver (whose receiver
/// type carries an open type parameter) was unreachable from any call
/// site — the lookup reported GS0159 "Cannot find function".
open class Issue773GenericReceiverDispatchTests {
    @Fact
    func Repro_FromIssue_IEnumerableT_Extension_Dispatches_On_Int32Slice() {
        const source = `
package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) MyFirst[T any](fb T) T {
    return fb
}

var arr = []int32{10, 20, 30}
arr.MyFirst(99)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(99, result.Value)
    }

    @Fact
    func SequenceT_Extension_Dispatches_On_Int32Slice() {
        const source = `
package P
import System

func (self sequence[T]) HeadOr[T](fb T) T {
    return fb
}

var arr = []int32{1, 2, 3}
arr.HeadOr(7)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(7, result.Value)
    }

    @Fact
    func SequenceT_Extension_Dispatches_On_StringSlice() {
        const source = `
package P
import System

func (self sequence[T]) HeadOr[T](fb T) T {
    return fb
}

var arr = []string{"a", "b"}
arr.HeadOr("z")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("z", result.Value)
    }

    @Fact
    func SequenceT_Extension_Dispatches_On_DictionaryKeys() {
        // `Dictionary[K, V].Keys` returns `KeyCollection` which implements
        // `IEnumerable<K>`. The extension `(self sequence[T])` must unify
        // T against the KeyCollection's element type by walking the CLR
        // interface set.
        const source = `
package P
import System
import System.Collections.Generic

func (self sequence[T]) HeadOr[T](fb T) T {
    return fb
}

var d = Dictionary[string, int32]()
d["a"] = 1
d.Keys.HeadOr("z")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("z", result.Value)
    }

    @Fact
    func NullableReceiver_Extension_Dispatches_On_StringNullable() {
        const source = `
package P
import System

func (self T?) MyOrElse[T](fb T) T {
    if self != nil { return self!! }
    return fb
}

var s string? = nil
s.MyOrElse("def")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("def", result.Value)
    }

    @Fact
    func NullableReceiver_Extension_Dispatches_On_Int32Nullable() {
        const source = `
package P
import System

func (self T?) MyOrElse[T](fb T) T {
    if self != nil { return self!! }
    return fb
}

var v int32? = nil
v.MyOrElse(99)
`
        // #3226: the emitted oracle handles the T? extension receiver on
        // Nullable<int32> through the unconstrained-nullable lift (MethodSpec
        // at Nullable<int32>).
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(99, result.Value)
    }

    @Fact
    func NullableReceiver_Extension_Dispatches_On_UserNullableStruct() {
        const source = `
package P
import System

struct Point {
    var X int32
    var Y int32
}

func (self T?) MyOrElse[T](fb T) T {
    if self != nil { return self!! }
    return fb
}

var pt Point? = nil
var def = Point{X: 1, Y: 2}
var r = pt.MyOrElse(def)
r.X
`
        // #3226: the nil user-struct Nullable receiver now dispatches to the
        // fallback on the emitted path too (the lift boxes Nullable<Point> for
        // the nil probe instead of reinterpreting it as a bare Point).
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    @Fact
    func MultiTypeParameters_DictionaryReceiver_Dispatches() {
        const source = `
package P
import System
import System.Collections.Generic

func (self Dictionary[K, V]) MyCount[K, V]() int32 {
    return 42
}

var d = Dictionary[string, int32]()
d.MyCount()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConstraintViolation_DoesNotDispatch() {
        // Issue #773 + ADR-0088: the generic-receiver path runs receiver
        // inference first, and then the call-site overload pipeline in
        // BindExtensionFunctionCall enforces the per-type-parameter
        // constraints. Calling `Foo` with a receiver that does not
        // satisfy the constraint must fail with the standard constraint
        // diagnostic.
        const source = `
package P
import System

sealed interface ITagged {
    func Tag() string;
}

func (self T) Branded[T ITagged]() string {
    return self.Tag()
}

var v = 1
v.Branded()
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Constraint_Satisfied_Dispatches() {
        const source = `
package P
import System

sealed interface ITagged {
    func Tag() string;
}

class Card : ITagged {
    func Tag() string {
        return "card"
    }
}

func (self T) Branded[T ITagged]() string {
    return self.Tag()
}

var c = Card()
c.Branded()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("card", result.Value)
    }

    @Fact
    func ClosedReceiver_StillWorks_AfterFix_OnNonGenericString() {
        // Regression guard: the fast-path exact-match for closed receivers
        // must still resolve. This was the working path pre-fix.
        const source = `
package P
import System

func (s string) Loud() string {
    return s + "!"
}

var greeting = "hi"
greeting.Loud()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("hi!", result.Value)
    }

    @Fact
    func ClosedReceiver_TakesPrecedenceOverGenericReceiver() {
        // Both extensions match the call site. The closed-receiver
        // declaration is preferred (it is the fast-path match) so the
        // returned string is "closed".
        const source = `
package P
import System

func (self []int32) Tag() string {
    return "closed"
}

func (self []T) Tag[T]() string {
    return "generic"
}

var arr = []int32{1, 2}
arr.Tag()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("closed", result.Value)
    }

    @Fact
    func GenericReceiver_OverSlice_OfT() {
        const source = `
package P
import System

func (self []T) MyCount[T]() int32 {
    return 7
}

var a = []int32{1, 2, 3}
a.MyCount()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(7, result.Value)
    }

    @Fact
    func GenericReceiver_TypeArgument_FlowsToBody() {
        // The substituted T must be observable through the body — a
        // parameter typed `T` must accept the inferred element type.
        const source = `
package P
import System

func (self []T) FirstOr[T](fb T) T {
    return fb
}

var a = []int32{1, 2, 3}
a.FirstOr(99)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(99, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
