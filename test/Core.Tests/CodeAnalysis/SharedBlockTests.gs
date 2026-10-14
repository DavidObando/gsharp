// <copyright file="SharedBlockTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Emitted-oracle coverage for shared block.
/// Traceability: ADR-0053.
open class SharedBlockTests {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Parser tests
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func SharedBlock_Parses_InClass() {
        let source = `
class Counter {
    shared {
        var count int32
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func SharedBlock_Parses_InStruct() {
        let source = `
struct Counter {
    shared {
        var count int32
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func SharedBlock_Parses_WithMethods() {
        let source = `
struct Factory {
    shared {
        func create() int32 {
            return 42
        }
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func SharedBlock_DuplicateSharedBlock_ReportsDiagnostic() {
        let source = `
struct Counter {
    shared {
        var x int32
    }
    shared {
        var y int32
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Message.Contains("shared"))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Binder tests
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func SharedBlock_StaticFieldAccess_Binds() {
        let source = `
struct Counter {
    shared {
        var count int32
    }
}

var x = Counter.count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func SharedBlock_StaticMethodCall_Binds() {
        let source = `
struct Factory {
    shared {
        func create() int32 {
            return 42
        }
    }
}

var x = Factory.create()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func SharedBlock_StaticField_AssignmentBinds() {
        let source = `
struct Counter {
    shared {
        var count int32
    }
}

Counter.count = 5
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Emitted-oracle tests
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func SharedBlock_StaticField_ReadWrite() {
        let source = `
struct Counter {
    shared {
        var count int32
    }
}

Counter.count = 42
var result = Counter.count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SharedBlock_StaticMethod_ReturnsValue() {
        let source = `
struct Factory {
    shared {
        func create() int32 {
            return 99
        }
    }
}

var result = Factory.create()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func SharedBlock_StaticField_SharedAcrossInstances() {
        let source = `
struct Counter {
    shared {
        var count int32
    }
}

Counter.count = 10
Counter.count = Counter.count + 5
var result = Counter.count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(15, result.Value)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Emit (compiled) tests
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func SharedBlock_StaticField_Emit_RoundTrip() {
        let source = `package SharedFieldEmit
import System

struct Counter {
    shared {
        var count int32
    }
}

Counter.count = 77
Console.WriteLine(Counter.count)
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticField")
        Assert.Contains("77", output)
    }

    @Fact
    func SharedBlock_StaticMethod_Emit_RoundTrip() {
        let source = `package SharedMethodEmit
import System

struct Factory {
    shared {
        func create() int32 {
            return 123
        }
    }
}

Console.WriteLine(Factory.create())
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticMethod")
        Assert.Contains("123", output)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Issue #262: Static field initializers and .cctor emission
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func SharedBlock_StaticFieldInitializer_Parses() {
        let source = `
struct Counter {
    shared {
        var count int32 = 42
    }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func SharedBlock_StaticFieldInitializer_Emit_RoundTrip() {
        let source = `package CctorEmit
import System

struct Counter {
    shared {
        var count int32 = 42
    }
}

Console.WriteLine(Counter.count)
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-CctorEmit")
        Assert.Contains("42", output)
    }

    @Fact
    func SharedBlock_MultipleStaticFieldInitializers_Emit_RoundTrip() {
        let source = `package CctorMulti
import System

struct Config {
    shared {
        var x int32 = 10
        var y int32 = 20
        var name string = "hello"
    }
}

Console.WriteLine(Config.x)
Console.WriteLine(Config.y)
Console.WriteLine(Config.name)
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-CctorMulti")
        Assert.Contains("10", output)
        Assert.Contains("20", output)
        Assert.Contains("hello", output)
    }

    @Fact
    func SharedBlock_StaticFieldInitializer_ZeroValue_NoCctor() {
        // A field with default(T) initializer (= 0 for int) should still work.
        let source = `package CctorZero
import System

struct Counter {
    shared {
        var count int32 = 0
        var active int32 = 5
    }
}

Console.WriteLine(Counter.count)
Console.WriteLine(Counter.active)
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-CctorZero")
        Assert.Contains("0", output)
        Assert.Contains("5", output)
    }

    @Fact
    func SharedBlock_StaticFieldInitializer_ClassType_Emit_RoundTrip() {
        let source = `package CctorClass
import System

class Service {
    shared {
        var instanceCount int32 = 100
    }
}

Console.WriteLine(Service.instanceCount)
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-CctorClass")
        Assert.Contains("100", output)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Issue #261: Implicit bare-name access to sibling static members
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func SharedBlock_ImplicitStaticFieldRead_InSharedMethod() {
        let source = `
class Foo {
    shared {
        var x int32
        func bar() int32 {
            return x
        }
    }
}

Foo.x = 42
var result = Foo.bar()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SharedBlock_ImplicitStaticFieldWrite_InSharedMethod() {
        let source = `
class Foo {
    shared {
        var x int32
        func setX(val int32) {
            x = val
        }
    }
}

Foo.setX(99)
var result = Foo.x
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func SharedBlock_ImplicitStaticFieldReadWrite_InSharedMethod() {
        let source = `
class Counter {
    shared {
        var count int32
        func increment() int32 {
            count = count + 1
            return count
        }
    }
}

Counter.count = 10
var result = Counter.increment()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func SharedBlock_ImplicitStaticFieldAccess_ChainedMemberAccess() {
        let source = `

class Holder {
    shared {
        var name string
        func getLen() int32 {
            return name.Length
        }
    }
}

Holder.name = "hello"
var result = Holder.getLen()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func SharedBlock_ParameterShadowsStaticField() {
        let source = `
class Foo {
    shared {
        var x int32
        func bar(x int32) int32 {
            return x
        }
    }
}

Foo.x = 100
var result = Foo.bar(7)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Issue #263: Static property accessor support in shared blocks
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func SharedBlock_StaticAutoProperty_ReadWrite() {
        let source = `
class Config {
    shared {
        prop name string
    }
}

Config.name = "hello"
var result = Config.name
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hello", result.Value)
    }

    @Fact
    func SharedBlock_StaticComputedProperty_Getter() {
        let source = `
class Counter {
    shared {
        var count int32
        prop doubled int32 {
            get { return count * 2 }
        }
    }
}

Counter.count = 21
var result = Counter.doubled
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SharedBlock_StaticComputedProperty_GetterSetter() {
        let source = `
class Config {
    shared {
        var _value int32
        prop value int32 {
            get { return _value }
            set(v) { _value = v }
        }
    }
}

Config.value = 99
var result = Config.value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func SharedBlock_StaticAutoProperty_Emit_RoundTrip() {
        let source = `package StaticAutoPropEmit
import System

class Config {
    shared {
        prop name string
    }
}

Config.name = "world"
Console.WriteLine(Config.name)
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticAutoProp")
        Assert.Contains("world", output)
    }

    @Fact
    func SharedBlock_StaticComputedProperty_Emit_RoundTrip() {
        let source = `package StaticComputedPropEmit
import System

class Counter {
    shared {
        var count int32
        prop doubled int32 {
            get { return count * 2 }
        }
    }
}

Counter.count = 21
Console.WriteLine(Counter.doubled)
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticComputedProp")
        Assert.Contains("42", output)
    }

    @Fact
    func SharedBlock_StaticComputedPropertyGetSet_Emit_RoundTrip() {
        let source = `package StaticComputedPropGetSetEmit
import System

class Config {
    shared {
        var _value int32
        prop value int32 {
            get { return _value }
            set(v) { _value = v }
        }
    }
}

Config.value = 77
Console.WriteLine(Config.value)
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticComputedPropGetSet")
        Assert.Contains("77", output)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Issue #263: Static event accessor support in shared blocks
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func SharedBlock_StaticFieldLikeEvent_Emit_RoundTrip() {
        let source = `package StaticEventEmit
import System

class EventBus {
    shared {
        event onNotify Action
    }
}

EventBus.onNotify += func() { }
Console.WriteLine("subscribed")
`
        let output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticEvent")
        Assert.Contains("subscribed", output)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Issue #418 (P1-7): PropertyMap must not orphan static PropertyDef rows
    // when instance properties are declared.  Even if every declared instance
    // property is skipped during emission (so no instance PropertyDef row is
    // produced), the static emission path must still add a PropertyMap row
    // pointing at the first static PropertyDef. Without it, the static rows
    // are unreachable from any TypeDef, violating ECMA-335 §II.22.35.
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func StaticProperty_OnTypeWithInstanceProperty_IsReachableViaReflection() {
        // Sanity check for the mixed instance + static scenario.  Both the
        // instance auto-property and the static auto-property must be
        // reflectable, which requires a valid PropertyMap row for the type.
        let source = `package MixedProps
import System

class Mixed {
    prop Name string
    shared {
        prop Counter int32
    }
}

Mixed.Counter = 7
var m = Mixed{}
m.Name = "hello"
Console.WriteLine(m.Name)
Console.WriteLine(Mixed.Counter)
`
        let output = CompileLoadInvokeCaptureStdout(source, "P1-7-MixedProps")
        Assert.Contains("hello", output)
        Assert.Contains("7", output)
    }

    @Fact
    func StaticProperty_OnTypeWithoutInstanceProperty_EmitsExactlyOnePropertyMapRow() {
        // Verifies the static-only case keeps producing exactly one PropertyMap
        // row pointing at the static PropertyDef.  Guards against regressions
        // in the new typesWithPropertyMap tracking introduced for issue #418.
        let source = `package StaticOnlyProp
import System

class Config {
    shared {
        prop Name string
    }
}

Config.Name = "world"
Console.WriteLine(Config.Name)
`
        using let peStream = MemoryStream()
        let result = Compile(source, peStream)
        Assert.True(result.Success)
        peStream.Position = 0
        using let peReader = PEReader(peStream)
        let md = peReader.GetMetadataReader()
        // Exactly one PropertyMap row for the static property on Config.
        let pmRows = md.GetTableRowCount(TableIndex.PropertyMap)
        Assert.Equal(1, pmRows)
        // Exactly one PropertyDef row (the static one).
        let pdRows = md.GetTableRowCount(TableIndex.Property)
        Assert.Equal(1, pdRows)
    }

    @Fact
    func StaticAndInstanceProperty_OnSameType_EmitsExactlyOnePropertyMapRow() {
        // When a type declares both instance and static properties, exactly
        // one PropertyMap row must exist, pointing at the first (instance)
        // PropertyDef.  Both PropertyDef rows belong to the same type via
        // ECMA-335 §II.22.35 contiguity.
        let source = `package MixedPropsShape
import System

class Mixed {
    prop Name string
    shared {
        prop Counter int32
    }
}
`
        using let peStream = MemoryStream()
        let result = Compile(source, peStream)
        Assert.True(result.Success)
        peStream.Position = 0
        using let peReader = PEReader(peStream)
        let md = peReader.GetMetadataReader()
        let pmRows = md.GetTableRowCount(TableIndex.PropertyMap)
        Assert.Equal(1, pmRows)
        let pdRows = md.GetTableRowCount(TableIndex.Property)
        Assert.Equal(2, pdRows)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. ADR-0053 §5 expansion: bare static-member access from instance
    //    methods (previously only allowed from shared methods), bare static-
    //    property access, and compound `+=` / `-=` on `Type.StaticMember`.
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func BareStaticField_InInstanceMethod_Read() {
        let source = `
class Counter {
    shared { var count int32 }
    func get() int32 { return count }
}

Counter.count = 17
var c = Counter{}
var r = c.get()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(17, result.Value)
    }

    @Fact
    func BareStaticField_InInstanceMethod_SimpleAssign() {
        let source = `
class Counter {
    shared { var count int32 }
    func set(v int32) { count = v }
}

var c = Counter{}
c.set(33)
var r = Counter.count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(33, result.Value)
    }

    @Fact
    func BareStaticField_InInstanceMethod_CompoundAssign() {
        let source = `
class Counter {
    shared { var count int32 }
    func bump() int32 {
        count += 1
        return count
    }
}

Counter.count = 5
var c = Counter{}
var r = c.bump()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func BareStaticProp_InInstanceMethod_Read() {
        let source = `
class Counter {
    shared { prop count int32 }
    func get() int32 { return count }
}

Counter.count = 12
var c = Counter{}
var r = c.get()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func BareStaticProp_InInstanceMethod_SimpleAssign() {
        let source = `
class Counter {
    shared { prop count int32 }
    func set(v int32) { count = v }
}

var c = Counter{}
c.set(81)
var r = Counter.count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(81, result.Value)
    }

    @Fact
    func BareStaticProp_InInstanceMethod_CompoundAssign() {
        let source = `
class Counter {
    shared { prop count int32 }
    func bump() int32 {
        count += 1
        return count
    }
}

Counter.count = 9
var c = Counter{}
var r = c.bump()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func BareStaticProp_InSharedMethod_Read() {
        let source = `
class Counter {
    shared {
        prop count int32
        func get() int32 { return count }
    }
}

Counter.count = 41
var r = Counter.get()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(41, result.Value)
    }

    @Fact
    func BareStaticProp_InSharedMethod_CompoundAssign() {
        let source = `
class Counter {
    shared {
        prop count int32
        func bump() int32 {
            count += 1
            return count
        }
    }
}

Counter.count = 7
var r = Counter.bump()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(8, result.Value)
    }

    @Fact
    func BareStaticField_InSharedMethod_CompoundAssign() {
        let source = `
class Counter {
    shared {
        var count int32
        func bump() int32 {
            count += 2
            return count
        }
    }
}

Counter.count = 3
var r = Counter.bump()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func TypeQualified_StaticField_CompoundAssign() {
        let source = `
class Counter {
    shared { var count int32 }
}

Counter.count = 4
Counter.count += 6
var r = Counter.count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func TypeQualified_StaticProp_CompoundAssign() {
        let source = `
class Counter {
    shared { prop count int32 }
}

Counter.count = 4
Counter.count += 6
var r = Counter.count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func TypeQualified_StaticField_CompoundMinus() {
        let source = `
class Counter {
    shared { var count int32 }
}

Counter.count = 20
Counter.count -= 7
var r = Counter.count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(13, result.Value)
    }

    @Fact
    func NameCollision_Parameter_ShadowsStatic_NoFalseSuccess() {
        // Parameter `count` shadows the same-named static field. The
        // existing shared-method seeding already enforces this; the new
        // instance-method seeding must do the same.
        let source = `
class Foo {
    shared { var count int32 }
    func echo(count int32) int32 { return count }
}

Foo.count = 1
var f = Foo{}
var r = f.echo(99)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func StaticField_FromAnotherInstanceMethod_QualifiedRead() {
        // Qualified read `Type.X` (regression — should keep working
        // after refactor that splits static-event vs static-field branches).
        let source = `
class Counter {
    shared { var count int32 }
    func get() int32 { return Counter.count }
}

Counter.count = 22
var c = Counter{}
var r = c.get()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(22, result.Value)
    }

    @Fact
    func StaticEvent_AndStaticField_OnSameType_BothCompoundAssignable() {
        // Regression for the restructured static-event branch in
        // BindEventSubscriptionExpression: a type with BOTH a static event
        // and a static field must still allow `Type.StaticEvent += handler`
        // (event), and must now ALSO allow `Type.StaticField += 1` (field
        // path — previously masked by the static-event branch returning an
        // unable-to-find error when the event name didn't match).
        let source = `package EventAndFieldCompound
import System

class Bus {
    shared {
        event Tick Action
        var count int32
    }
}

func handler() { }

Bus.Tick += handler
Bus.count = 5
Bus.count += 3
Console.WriteLine(Bus.count)
`
        let output = CompileLoadInvokeCaptureStdout(source, "ADR53-EventAndFieldCompound")
        Assert.Contains("8", output)
    }

    @Fact
    func StaticGetterOnlyProp_BareCompound_ReportsCannotAssign() {
        // `+=` requires both a getter and a setter. A getter-only static
        // property must fail with `CannotAssign` (GS0127) on the bare
        // compound path.
        let source = `
class Foo {
    shared {
        var _v int32
        prop value int32 { get { return _v } }
        func bump() { value += 1 }
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func StaticSetterOnlyProp_BareCompound_ReportsCannotAssign() {
        // `+=` requires both a getter and a setter. A setter-only static
        // property must fail with `CannotAssign` (GS0127) on the bare
        // compound path.
        let source = `
class Foo {
    shared {
        var _v int32
        prop value int32 { set(v) { _v = v } }
        func bump() { value += 1 }
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func TypeQualified_StaticGetterOnlyProp_CompoundReportsCannotAssign() {
        let source = `
class Foo {
    shared {
        var _v int32
        prop value int32 { get { return _v } }
    }
}

Foo.value += 1
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func GenericType_BareStatic_InInstanceMethod_CompoundAssign() {
        // function.ReceiverType for a method on type Container[T] is the
        // generic definition, whose StaticFields/StaticProperties are
        // populated. StructSymbol.Construct does not propagate statics to
        // constructed instantiations, but body-bind uses the definition, so
        // bare static access from an instance method on a generic type
        // must still resolve.
        let source = `
class Container[T] {
    shared { var count int32 }
    var Value T
    func bump() int32 {
        count += 1
        return count
    }
}

var c = Container[int32]{Value: 10}
var unused = c.bump()
var r = c.bump()
r
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func BareStaticField_InInstanceMethod_InsideGoScope_Works() {
        // Static access in a body launched via `go` (inside a `scope`)
        // needs no receiver capture, so it should compile and run. The
        // increment uses Interlocked so the fixture is race-free: three
        // goroutines racing a plain `count += 1` read-modify-write can
        // legitimately observe a final count under 3 (issue #3612). The
        // point under test is bare static field access from a `go` body,
        // not increment atomicity, so make the arithmetic atomic instead
        // of asserting a racy outcome.
        let source = `package BareStaticInGo
import System
import System.Threading

class Bus {
    shared { var count int32 }
    func bump() int32 {
        Interlocked.Increment(ref count)
        return count
    }
}

Bus.count = 0
var b = Bus{}
scope {
    go b.bump()
    go b.bump()
    go b.bump()
}
Console.WriteLine(Bus.count)
`
        let output = CompileLoadInvokeCaptureStdout(source, "ADR53-BareStaticInGo")
        Assert.Contains("3", output)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. ADR-0053 §5 expansion: end-to-end repro from user bug report.
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func Repro_UserBug_BareAndQualifiedStaticPropFromInstanceMethod() {
        // Faithful reproduction of the original failing program from the
        // user bug report. Pre-fix, this errored with three GS0125
        // "Variable doesn't exist" diagnostics inside `ToString()`.
        let source = `package ReproUserBug
import System

class Person {
    shared {
        prop CallCount int32
    }
    public prop Name string
    public prop Age int32

    func ToString() string {
        CallCount += 1
        Person.CallCount += 1
        return "Name: ${Name}, Age: ${this.Age}"
    }
}

Person.CallCount = 23
var person = Person{}
person.Name = "Alice"
person.Age = 30
Console.WriteLine(person.ToString())
Console.WriteLine(person.ToString())
Console.WriteLine("CallCount: ${Person.CallCount}")
`
        let output = CompileLoadInvokeCaptureStdout(source, "ADR53-ReproUserBug")
        // Two ToString() calls × (bare CallCount += 1 + qualified Person.CallCount += 1)
        // = 4 increments from the initial 23 → final 27.
        Assert.Contains("CallCount: 27", output)
    }

    shared {
        // ─────────────────────────────────────────────────────────────────────────
        // Helpers
        // ─────────────────────────────────────────────────────────────────────────
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
