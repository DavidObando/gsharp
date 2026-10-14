// <copyright file="ClrMemberAccessTests.cs" company="GSharp">
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

/// Phase 4 exit (part 2) — member access on CLR instance values. Covers
/// instance property/field reads, indexer reads, and indexer writes
/// (including keyed writes on `Dictionary[K, V]`).
open class ClrMemberAccessTests {
    @Fact
    func ListCount_PropertyRead_Binds() {
        let source = `
import System.Collections.Generic

var lst = List[int32]()
lst.Add(1)
lst.Add(2)
var n = lst.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func StringBuilderLength_PropertyRead_Binds() {
        let source = `
import System.Text

var sb = StringBuilder()
sb.Append("abc")
var n = sb.Length
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DictionaryIndexer_KeyedWriteAndRead_Bind() {
        let source = `
import System.Collections.Generic

var d = Dictionary[string, int32]()
d["k"] = 42
var v = d["k"]
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ListIndexer_ReadByIntKey_Binds() {
        let source = `
import System.Collections.Generic

var lst = List[int32]()
lst.Add(7)
var first = lst[0]
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DictionaryIndexer_WrongKeyType_Diagnoses() {
        let source = `
import System.Collections.Generic

var d = Dictionary[string, int32]()
var v = d[5]
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func ClrMember_UnknownProperty_Diagnoses() {
        let source = `
import System.Text

var sb = StringBuilder()
var x = sb.NotAReal
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func StaticProperty_Read_Binds() {
        // Stream B: bare `Foo.SomeStaticProperty` should bind via
        // ImportedClassSymbol.TryLookupMember and evaluate without diagnostics.
        let source = `
import System

var maxInt = Int32.MaxValue
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int32.MaxValue, result.Value)
    }

    @Fact
    func StaticField_Read_Binds() {
        let source = `
import System

var e = String.Empty
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(string.Empty, result.Value)
    }

    @Fact
    func StringEmpty_LowercaseAlias_Binds() {
        // Issue #919: the lowercase `string` predefined alias must resolve as a
        // static-member-access receiver identically to the capitalized `String`
        // form — and without requiring `import System`, since `string` is a
        // built-in keyword alias for System.String.
        let source = `
var e = string.Empty
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(string.Empty, result.Value)
    }

    @Fact
    func Int32MaxValue_LowercaseAlias_Binds() {
        // Issue #919: the same fix applies to the other lowercase primitive
        // aliases. `int32.MaxValue` must bind like `Int32.MaxValue`.
        let source = `
var m = int32.MaxValue
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int32.MaxValue, result.Value)
    }

    @Fact
    func IntFriendlyAliasMaxValue_Binds() {
        // Issue #919 / ADR-0098: friendly numeric aliases (`int`) route to the
        // same canonical CLR type, so static member access binds too.
        let source = `
var m = int.MaxValue
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int32.MaxValue, result.Value)
    }

    @Fact
    func ObjectReferenceEquals_LowercaseAlias_Binds() {
        let result = Evaluate(`class Item { }
let item = Item{}
object.ReferenceEquals(item, item)`)
        Assert.Empty(result.Diagnostics)
        Assert.True(bool(result.Value))
    }

    @Fact
    func ShadowedClrAlias_UsesStaticTypeOrInstanceValueByMemberKind() {
        let result = Evaluate(`func Same(object string, left object, right object) bool -> object.ReferenceEquals(left, right)
func Length(object string) int32 -> object.Length
let value object = "same"
Same("shadow", value, value) && Length("shadow") == 6`)
        Assert.Empty(result.Diagnostics)
        Assert.True(bool(result.Value))
    }

    @Fact
    func ClrTypeReceiver_RejectsInstanceMethod() {
        let result = Evaluate("func Bad() string? -> object.ToString()")
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
    }

    @Fact
    func ClrInstanceReceiver_RejectsStaticMethod() {
        let result = Evaluate("func Bad(value object) bool -> value.ReferenceEquals(value, value)")
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
    }

    @Fact
    func StringEmpty_LowercaseAlias_UnknownMember_Diagnoses() {
        // The lowercase alias receiver still reports unknown members rather than
        // silently binding.
        let source = `
var e = string.NotAReal
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func StaticProperty_UnknownMember_Diagnoses() {
        let source = `
import System

var x = Int32.NotAReal
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func InstanceProperty_Write_RoundTrips() {
        // Stream B: writing a settable CLR instance property routes through
        // BoundClrPropertyAssignmentExpression and updates the underlying
        // receiver. Reading it back via the existing read path verifies the
        // round-trip through emitted execution.
        let source = `
import System.Text

var sb = StringBuilder()
sb.Capacity = 64
var c = sb.Capacity
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(64, result.Value)
    }

    @Fact
    func InstanceProperty_ReadOnly_Diagnoses() {
        let source = `
import System.Collections.Generic

var lst = List[int32]()
lst.Count = 5
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func EventSubscription_AddAndRemoveHandler_Binds() {
        // Stream B′: subscribing to a CLR event with `+=` and unsubscribing
        // with `-=` should bind without diagnostics and route through
        // BoundClrEventSubscriptionExpression. We use AppDomain.ProcessExit
        // (a regular EventHandler) and exercise both operators so the
        // remove-path is covered too.
        let source = `
import System

var d = AppDomain.CurrentDomain
let h = func(sender Object, e EventArgs) { }
d.ProcessExit += h
d.ProcessExit -= h
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func EventSubscription_UnknownEvent_Diagnoses() {
        let source = `
import System

var d = AppDomain.CurrentDomain
let h = func(sender Object, e EventArgs) { }
d.NoSuchEvent += h
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func EventSubscription_StaticEvent_Binds() {
        // Static-event form: `Class.Event += handler`. Console.CancelKeyPress
        // is a static event with a ConsoleCancelEventHandler signature.
        let source = `
import System

let h = func(sender Object, e ConsoleCancelEventArgs) { }
Console.CancelKeyPress += h
Console.CancelKeyPress -= h
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
