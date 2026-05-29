// <copyright file="SharedBlockTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
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
}
