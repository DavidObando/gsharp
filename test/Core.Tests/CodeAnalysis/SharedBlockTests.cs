// <copyright file="SharedBlockTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0053 Phase E — comprehensive tests for the <c>shared { … }</c> block feature
/// covering parser, binder, evaluator, and emit round-trip scenarios.
/// </summary>
public class SharedBlockTests
{
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Parser tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_Parses_InClass()
    {
        var source = @"
type Counter class {
    shared {
        count int32
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void SharedBlock_Parses_InStruct()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void SharedBlock_Parses_WithMethods()
    {
        var source = @"
type Factory struct {
    shared {
        func create() int32 {
            return 42
        }
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void SharedBlock_DuplicateSharedBlock_ReportsDiagnostic()
    {
        var source = @"
type Counter struct {
    shared {
        x int32
    }
    shared {
        y int32
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
        Assert.Contains(tree.Diagnostics, d => d.Message.Contains("shared"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Binder tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_StaticFieldAccess_Binds()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}

var x = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SharedBlock_StaticMethodCall_Binds()
    {
        var source = @"
type Factory struct {
    shared {
        func create() int32 {
            return 42
        }
    }
}

var x = Factory.create()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SharedBlock_StaticField_AssignmentBinds()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}

Counter.count = 5
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Evaluator (interpreter) tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_StaticField_ReadWrite()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}

Counter.count = 42
var result = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SharedBlock_StaticMethod_ReturnsValue()
    {
        var source = @"
type Factory struct {
    shared {
        func create() int32 {
            return 99
        }
    }
}

var result = Factory.create()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void SharedBlock_StaticField_SharedAcrossInstances()
    {
        var source = @"
type Counter struct {
    shared {
        count int32
    }
}

Counter.count = 10
Counter.count = Counter.count + 5
var result = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(15, result.Value);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Emit (compiled) tests
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_StaticField_Emit_RoundTrip()
    {
        var source = @"package SharedFieldEmit
import System

type Counter struct {
    shared {
        count int32
    }
}

Counter.count = 77
Console.WriteLine(Counter.count)
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticField");
        Assert.Contains("77", output);
    }

    [Fact]
    public void SharedBlock_StaticMethod_Emit_RoundTrip()
    {
        var source = @"package SharedMethodEmit
import System

type Factory struct {
    shared {
        func create() int32 {
            return 123
        }
    }
}

Console.WriteLine(Factory.create())
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticMethod");
        Assert.Contains("123", output);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Issue #262: Static field initializers and .cctor emission
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_StaticFieldInitializer_Parses()
    {
        var source = @"
type Counter struct {
    shared {
        count int32 = 42
    }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void SharedBlock_StaticFieldInitializer_Emit_RoundTrip()
    {
        var source = @"package CctorEmit
import System

type Counter struct {
    shared {
        count int32 = 42
    }
}

Console.WriteLine(Counter.count)
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-CctorEmit");
        Assert.Contains("42", output);
    }

    [Fact]
    public void SharedBlock_MultipleStaticFieldInitializers_Emit_RoundTrip()
    {
        var source = @"package CctorMulti
import System

type Config struct {
    shared {
        x int32 = 10
        y int32 = 20
        name string = ""hello""
    }
}

Console.WriteLine(Config.x)
Console.WriteLine(Config.y)
Console.WriteLine(Config.name)
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-CctorMulti");
        Assert.Contains("10", output);
        Assert.Contains("20", output);
        Assert.Contains("hello", output);
    }

    [Fact]
    public void SharedBlock_StaticFieldInitializer_ZeroValue_NoCctor()
    {
        // A field with default(T) initializer (= 0 for int) should still work.
        var source = @"package CctorZero
import System

type Counter struct {
    shared {
        count int32 = 0
        active int32 = 5
    }
}

Console.WriteLine(Counter.count)
Console.WriteLine(Counter.active)
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-CctorZero");
        Assert.Contains("0", output);
        Assert.Contains("5", output);
    }

    [Fact]
    public void SharedBlock_StaticFieldInitializer_ClassType_Emit_RoundTrip()
    {
        var source = @"package CctorClass
import System

type Service class {
    shared {
        instanceCount int32 = 100
    }
}

Console.WriteLine(Service.instanceCount)
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-CctorClass");
        Assert.Contains("100", output);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, parameters: null);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Issue #261: Implicit bare-name access to sibling static members
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_ImplicitStaticFieldRead_InSharedMethod()
    {
        var source = @"
type Foo class {
    shared {
        x int32
        func bar() int32 {
            return x
        }
    }
}

Foo.x = 42
var result = Foo.bar()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SharedBlock_ImplicitStaticFieldWrite_InSharedMethod()
    {
        var source = @"
type Foo class {
    shared {
        x int32
        func setX(val int32) {
            x = val
        }
    }
}

Foo.setX(99)
var result = Foo.x
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void SharedBlock_ImplicitStaticFieldReadWrite_InSharedMethod()
    {
        var source = @"
type Counter class {
    shared {
        count int32
        func increment() int32 {
            count = count + 1
            return count
        }
    }
}

Counter.count = 10
var result = Counter.increment()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void SharedBlock_ImplicitStaticFieldAccess_ChainedMemberAccess()
    {
        var source = @"
type Holder class {
    shared {
        name string
        func getLen() int32 {
            return len(name)
        }
    }
}

Holder.name = ""hello""
var result = Holder.getLen()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void SharedBlock_ParameterShadowsStaticField()
    {
        var source = @"
type Foo class {
    shared {
        x int32
        func bar(x int32) int32 {
            return x
        }
    }
}

Foo.x = 100
var result = Foo.bar(7)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Issue #263: Static property accessor support in shared blocks
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_StaticAutoProperty_ReadWrite()
    {
        var source = @"
type Config class {
    shared {
        prop name string
    }
}

Config.name = ""hello""
var result = Config.name
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hello", result.Value);
    }

    [Fact]
    public void SharedBlock_StaticComputedProperty_Getter()
    {
        var source = @"
type Counter class {
    shared {
        count int32
        prop doubled int32 {
            get { return count * 2 }
        }
    }
}

Counter.count = 21
var result = Counter.doubled
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SharedBlock_StaticComputedProperty_GetterSetter()
    {
        var source = @"
type Config class {
    shared {
        _value int32
        prop value int32 {
            get { return _value }
            set(v) { _value = v }
        }
    }
}

Config.value = 99
var result = Config.value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void SharedBlock_StaticAutoProperty_Emit_RoundTrip()
    {
        var source = @"package StaticAutoPropEmit
import System

type Config class {
    shared {
        prop name string
    }
}

Config.name = ""world""
Console.WriteLine(Config.name)
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticAutoProp");
        Assert.Contains("world", output);
    }

    [Fact]
    public void SharedBlock_StaticComputedProperty_Emit_RoundTrip()
    {
        var source = @"package StaticComputedPropEmit
import System

type Counter class {
    shared {
        count int32
        prop doubled int32 {
            get { return count * 2 }
        }
    }
}

Counter.count = 21
Console.WriteLine(Counter.doubled)
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticComputedProp");
        Assert.Contains("42", output);
    }

    [Fact]
    public void SharedBlock_StaticComputedPropertyGetSet_Emit_RoundTrip()
    {
        var source = @"package StaticComputedPropGetSetEmit
import System

type Config class {
    shared {
        _value int32
        prop value int32 {
            get { return _value }
            set(v) { _value = v }
        }
    }
}

Config.value = 77
Console.WriteLine(Config.value)
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticComputedPropGetSet");
        Assert.Contains("77", output);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Issue #263: Static event accessor support in shared blocks
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void SharedBlock_StaticFieldLikeEvent_Emit_RoundTrip()
    {
        var source = @"package StaticEventEmit
import System

type EventBus class {
    shared {
        event onNotify Action
    }
}

EventBus.onNotify += func() { }
Console.WriteLine(""subscribed"")
";
        var output = CompileLoadInvokeCaptureStdout(source, "SharedBlock-StaticEvent");
        Assert.Contains("subscribed", output);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Issue #418 (P1-7): PropertyMap must not orphan static PropertyDef rows
    // when instance properties are declared.  Even if every declared instance
    // property is skipped during emission (so no instance PropertyDef row is
    // produced), the static emission path must still add a PropertyMap row
    // pointing at the first static PropertyDef. Without it, the static rows
    // are unreachable from any TypeDef, violating ECMA-335 §II.22.35.
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void StaticProperty_OnTypeWithInstanceProperty_IsReachableViaReflection()
    {
        // Sanity check for the mixed instance + static scenario.  Both the
        // instance auto-property and the static auto-property must be
        // reflectable, which requires a valid PropertyMap row for the type.
        var source = @"package MixedProps
import System

type Mixed class {
    prop Name string
    shared {
        prop Counter int32
    }
}

Mixed.Counter = 7
var m = Mixed{}
m.Name = ""hello""
Console.WriteLine(m.Name)
Console.WriteLine(Mixed.Counter)
";
        var output = CompileLoadInvokeCaptureStdout(source, "P1-7-MixedProps");
        Assert.Contains("hello", output);
        Assert.Contains("7", output);
    }

    [Fact]
    public void StaticProperty_OnTypeWithoutInstanceProperty_EmitsExactlyOnePropertyMapRow()
    {
        // Verifies the static-only case keeps producing exactly one PropertyMap
        // row pointing at the static PropertyDef.  Guards against regressions
        // in the new typesWithPropertyMap tracking introduced for issue #418.
        var source = @"package StaticOnlyProp
import System

type Config class {
    shared {
        prop Name string
    }
}

Config.Name = ""world""
Console.WriteLine(Config.Name)
";
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(result.Success);

        peStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var md = peReader.GetMetadataReader();

        // Exactly one PropertyMap row for the static property on Config.
        var pmRows = md.GetTableRowCount(TableIndex.PropertyMap);
        Assert.Equal(1, pmRows);

        // Exactly one PropertyDef row (the static one).
        var pdRows = md.GetTableRowCount(TableIndex.Property);
        Assert.Equal(1, pdRows);
    }

    [Fact]
    public void StaticAndInstanceProperty_OnSameType_EmitsExactlyOnePropertyMapRow()
    {
        // When a type declares both instance and static properties, exactly
        // one PropertyMap row must exist, pointing at the first (instance)
        // PropertyDef.  Both PropertyDef rows belong to the same type via
        // ECMA-335 §II.22.35 contiguity.
        var source = @"package MixedPropsShape
import System

type Mixed class {
    prop Name string
    shared {
        prop Counter int32
    }
}
";
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(result.Success);

        peStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var md = peReader.GetMetadataReader();

        var pmRows = md.GetTableRowCount(TableIndex.PropertyMap);
        Assert.Equal(1, pmRows);

        var pdRows = md.GetTableRowCount(TableIndex.Property);
        Assert.Equal(2, pdRows);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. ADR-0053 §5 expansion: bare static-member access from instance
    //    methods (previously only allowed from shared methods), bare static-
    //    property access, and compound `+=` / `-=` on `Type.StaticMember`.
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void BareStaticField_InInstanceMethod_Read()
    {
        var source = @"
type Counter class {
    shared { count int32 }
    func get() int32 { return count }
}

Counter.count = 17
var c = Counter{}
var r = c.get()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(17, result.Value);
    }

    [Fact]
    public void BareStaticField_InInstanceMethod_SimpleAssign()
    {
        var source = @"
type Counter class {
    shared { count int32 }
    func set(v int32) { count = v }
}

var c = Counter{}
c.set(33)
var r = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(33, result.Value);
    }

    [Fact]
    public void BareStaticField_InInstanceMethod_CompoundAssign()
    {
        var source = @"
type Counter class {
    shared { count int32 }
    func bump() int32 {
        count += 1
        return count
    }
}

Counter.count = 5
var c = Counter{}
var r = c.bump()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void BareStaticProp_InInstanceMethod_Read()
    {
        var source = @"
type Counter class {
    shared { prop count int32 }
    func get() int32 { return count }
}

Counter.count = 12
var c = Counter{}
var r = c.get()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void BareStaticProp_InInstanceMethod_SimpleAssign()
    {
        var source = @"
type Counter class {
    shared { prop count int32 }
    func set(v int32) { count = v }
}

var c = Counter{}
c.set(81)
var r = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(81, result.Value);
    }

    [Fact]
    public void BareStaticProp_InInstanceMethod_CompoundAssign()
    {
        var source = @"
type Counter class {
    shared { prop count int32 }
    func bump() int32 {
        count += 1
        return count
    }
}

Counter.count = 9
var c = Counter{}
var r = c.bump()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void BareStaticProp_InSharedMethod_Read()
    {
        var source = @"
type Counter class {
    shared {
        prop count int32
        func get() int32 { return count }
    }
}

Counter.count = 41
var r = Counter.get()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(41, result.Value);
    }

    [Fact]
    public void BareStaticProp_InSharedMethod_CompoundAssign()
    {
        var source = @"
type Counter class {
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
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void BareStaticField_InSharedMethod_CompoundAssign()
    {
        var source = @"
type Counter class {
    shared {
        count int32
        func bump() int32 {
            count += 2
            return count
        }
    }
}

Counter.count = 3
var r = Counter.bump()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void TypeQualified_StaticField_CompoundAssign()
    {
        var source = @"
type Counter class {
    shared { count int32 }
}

Counter.count = 4
Counter.count += 6
var r = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void TypeQualified_StaticProp_CompoundAssign()
    {
        var source = @"
type Counter class {
    shared { prop count int32 }
}

Counter.count = 4
Counter.count += 6
var r = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void TypeQualified_StaticField_CompoundMinus()
    {
        var source = @"
type Counter class {
    shared { count int32 }
}

Counter.count = 20
Counter.count -= 7
var r = Counter.count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void NameCollision_Parameter_ShadowsStatic_NoFalseSuccess()
    {
        // Parameter `count` shadows the same-named static field. The
        // existing shared-method seeding already enforces this; the new
        // instance-method seeding must do the same.
        var source = @"
type Foo class {
    shared { count int32 }
    func echo(count int32) int32 { return count }
}

Foo.count = 1
var f = Foo{}
var r = f.echo(99)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void StaticField_FromAnotherInstanceMethod_QualifiedRead()
    {
        // Qualified read `Type.X` (regression — should keep working
        // after refactor that splits static-event vs static-field branches).
        var source = @"
type Counter class {
    shared { count int32 }
    func get() int32 { return Counter.count }
}

Counter.count = 22
var c = Counter{}
var r = c.get()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(22, result.Value);
    }

    [Fact]
    public void StaticEvent_AndStaticField_OnSameType_BothCompoundAssignable()
    {
        // Regression for the restructured static-event branch in
        // BindEventSubscriptionExpression: a type with BOTH a static event
        // and a static field must still allow `Type.StaticEvent += handler`
        // (event), and must now ALSO allow `Type.StaticField += 1` (field
        // path — previously masked by the static-event branch returning an
        // unable-to-find error when the event name didn't match).
        var source = @"package EventAndFieldCompound
import System

type Bus class {
    shared {
        event Tick Action
        count int32
    }
}

func handler() { }

Bus.Tick += handler
Bus.count = 5
Bus.count += 3
Console.WriteLine(Bus.count)
";
        var output = CompileLoadInvokeCaptureStdout(source, "ADR53-EventAndFieldCompound");
        Assert.Contains("8", output);
    }

    [Fact]
    public void StaticGetterOnlyProp_BareCompound_ReportsCannotAssign()
    {
        // `+=` requires both a getter and a setter. A getter-only static
        // property must fail with `CannotAssign` (GS0127) on the bare
        // compound path.
        var source = @"
type Foo class {
    shared {
        _v int32
        prop value int32 { get { return _v } }
        func bump() { value += 1 }
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void StaticSetterOnlyProp_BareCompound_ReportsCannotAssign()
    {
        // `+=` requires both a getter and a setter. A setter-only static
        // property must fail with `CannotAssign` (GS0127) on the bare
        // compound path.
        var source = @"
type Foo class {
    shared {
        _v int32
        prop value int32 { set(v) { _v = v } }
        func bump() { value += 1 }
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void TypeQualified_StaticGetterOnlyProp_CompoundReportsCannotAssign()
    {
        var source = @"
type Foo class {
    shared {
        _v int32
        prop value int32 { get { return _v } }
    }
}

Foo.value += 1
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void GenericType_BareStatic_InInstanceMethod_CompoundAssign()
    {
        // function.ReceiverType for a method on type Container[T] is the
        // generic definition, whose StaticFields/StaticProperties are
        // populated. StructSymbol.Construct does not propagate statics to
        // constructed instantiations, but body-bind uses the definition, so
        // bare static access from an instance method on a generic type
        // must still resolve.
        var source = @"
type Container[T] class {
    shared { count int32 }
    Value T
    func bump() int32 {
        count += 1
        return count
    }
}

var c = Container[int32]{Value: 10}
var unused = c.bump()
var r = c.bump()
r
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void BareStaticField_InInstanceMethod_InsideGoScope_Works()
    {
        // Static access in a body launched via `go` (inside a `scope`)
        // needs no receiver capture, so it should compile and run.
        var source = @"package BareStaticInGo
import System

type Bus class {
    shared { count int32 }
    func bump() int32 {
        count += 1
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
";
        var output = CompileLoadInvokeCaptureStdout(source, "ADR53-BareStaticInGo");
        Assert.Contains("3", output);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. ADR-0053 §5 expansion: end-to-end repro from user bug report.
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void Repro_UserBug_BareAndQualifiedStaticPropFromInstanceMethod()
    {
        // Faithful reproduction of the original failing program from the
        // user bug report. Pre-fix, this errored with three GS0125
        // "Variable doesn't exist" diagnostics inside `ToString()`.
        var source = @"package ReproUserBug
import System

type Person class {
    shared {
        prop CallCount int32
    }
    public prop Name string
    public prop Age int32

    func ToString() string {
        CallCount += 1
        Person.CallCount += 1
        return ""Name: ${Name}, Age: ${this.Age}""
    }
}

Person.CallCount = 23
var person = Person{}
person.Name = ""Alice""
person.Age = 30
Console.WriteLine(person.ToString())
Console.WriteLine(person.ToString())
Console.WriteLine(""CallCount: ${Person.CallCount}"")
";
        var output = CompileLoadInvokeCaptureStdout(source, "ADR53-ReproUserBug");
        // Two ToString() calls × (bare CallCount += 1 + qualified Person.CallCount += 1)
        // = 4 increments from the initial 23 → final 27.
        Assert.Contains("CallCount: 27", output);
    }
}
