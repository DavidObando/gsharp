// <copyright file="Issue1610InterfaceByRefSignatureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #1610: interface methods with <c>ref</c>/<c>out</c>/<c>in</c>
/// parameters must encode byref (<c>T&amp;</c>) signatures — plus the
/// <c>IsReadOnlyAttribute</c> modreq for <c>in</c> — on the abstract
/// (and static-virtual) interface slots, exactly like the implementing
/// class-method path does. Before the fix the interface slot encoded the
/// parameter by value, so the implementing class's byref signature never
/// matched the slot and the CLR threw <see cref="TypeLoadException"/>
/// ("does not have an implementation") at type load. The same emit path
/// also never added Param rows, leaving interface parameters nameless in
/// metadata. Each test compiles a G# program with an interface contract
/// carrying ref-kind parameters plus an implementing class, then asserts
/// runtime dispatch behaviour and/or emitted-metadata shape.
/// </summary>
public class Issue1610InterfaceByRefSignatureEmitTests
{
    [Fact]
    public void InterfaceOutParameter_DispatchThroughInterface_RunsWithoutTypeLoadException()
    {
        // The exact repro from issue #1610: before the fix this program
        // compiled with zero diagnostics and died at type load with
        // "Method 'TryParse' ... does not have an implementation".
        const string Source = @"package IfaceOut
import System

interface Parser {
    func TryParse(s string, out result int32) bool;
}

class IntParser : Parser {
    func TryParse(s string, out result int32) bool {
        result = 42
        return true
    }
}

var p Parser = IntParser()
var r = 0
if p.TryParse(""x"", &r) {
    Console.WriteLine(r)
}
";
        var output = CompileAndRun(Source, "IfaceOut");
        Assert.Contains("42", output);
    }

    [Fact]
    public void InterfaceRefParameter_DispatchThroughInterface_MutatesCallerVariable()
    {
        const string Source = @"package IfaceRef
import System

interface Bumper {
    func Bump(ref counter int32, by int32);
}

class Adder : Bumper {
    func Bump(ref counter int32, by int32) {
        counter = counter + by
    }
}

var b Bumper = Adder()
var n = 5
b.Bump(&n, 10)
Console.WriteLine(n)
";
        var output = CompileAndRun(Source, "IfaceRef");
        Assert.Contains("15", output);
    }

    [Fact]
    public void InterfaceInParameter_DispatchThroughInterface_SeesCallerValue()
    {
        const string Source = @"package IfaceIn
import System

interface Scaler {
    func Scale(in factor int32) int32;
}

class Tripler : Scaler {
    func Scale(in factor int32) int32 {
        return factor * 3
    }
}

var s Scaler = Tripler()
var f = 14
Console.WriteLine(s.Scale(&f))
";
        var output = CompileAndRun(Source, "IfaceIn");
        Assert.Contains("42", output);
    }

    [Fact]
    public void InterfaceOutParameter_DispatchThroughClassReceiver_AlsoWorks()
    {
        // The class-typed call path exercises the implementing MethodDef
        // directly while the interface slot still participates in type load.
        const string Source = @"package IfaceClassRecv
import System

interface Parser {
    func TryParse(s string, out result int32) bool;
}

class IntParser : Parser {
    func TryParse(s string, out result int32) bool {
        result = 7
        return true
    }
}

var p = IntParser()
var r = 0
p.TryParse(""x"", &r)
Console.WriteLine(r)
";
        var output = CompileAndRun(Source, "IfaceClassRecv");
        Assert.Contains("7", output);
    }

    [Fact]
    public void StaticVirtualInterfaceMethod_OutParameter_DispatchesThroughTypeParameter()
    {
        // ADR-0089 static-virtual slots share the same (previously broken)
        // interface signature-emit path — EmitStaticVirtualMethod.
        const string Source = @"package IfaceSharedOut
import System

interface IAdd {
    shared {
        func AddInto(a int32, b int32, out result int32);
    }
}

class Adder : IAdd {
    shared {
        func AddInto(a int32, b int32, out result int32) {
            result = a + b
        }
    }
}

func Sum[T IAdd](w T, a int32, b int32) int32 {
    var r = 0
    T.AddInto(a, b, &r)
    return r
}

Console.WriteLine(Sum(Adder{}, 20, 22))
";
        var output = CompileAndRun(Source, "IfaceSharedOut");
        Assert.Contains("42", output);
    }

    [Fact]
    public void InterfaceMethod_RefKindParameters_EmitByRefFlagsModreqAndNames()
    {
        const string Source = @"package IfaceMeta
import System

interface Mutator {
    func TryParse(s string, out result int32) bool;
    func Bump(ref counter int32, by int32);
    func Scale(in factor int32) int32;
}

class Impl : Mutator {
    func TryParse(s string, out result int32) bool {
        result = 42
        return true
    }

    func Bump(ref counter int32, by int32) {
        counter = counter + by
    }

    func Scale(in factor int32) int32 {
        return factor * 3
    }
}
";
        var asm = CompileToAssembly(Source, "IfaceMeta");
        var iface = asm.GetTypes().Single(t => t.Name == "Mutator");
        Assert.True(iface.IsInterface);

        // out: byref + [Out] flag + parameter name kept in metadata.
        var tryParse = iface.GetMethod("TryParse", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(tryParse);
        var tryParseParams = tryParse!.GetParameters();
        Assert.Equal(2, tryParseParams.Length);
        Assert.Equal("s", tryParseParams[0].Name);
        Assert.False(tryParseParams[0].ParameterType.IsByRef);
        Assert.Equal("result", tryParseParams[1].Name);
        Assert.True(tryParseParams[1].ParameterType.IsByRef, "interface out parameter must be ByRef");
        Assert.True(tryParseParams[1].IsOut, "interface out parameter must carry [Out]");
        Assert.False(tryParseParams[1].IsIn);

        // ref: byref, neither [In] nor [Out].
        var bump = iface.GetMethod("Bump", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(bump);
        var bumpParams = bump!.GetParameters();
        Assert.Equal("counter", bumpParams[0].Name);
        Assert.True(bumpParams[0].ParameterType.IsByRef, "interface ref parameter must be ByRef");
        Assert.False(bumpParams[0].IsOut);
        Assert.False(bumpParams[0].IsIn);
        Assert.Equal("by", bumpParams[1].Name);
        Assert.False(bumpParams[1].ParameterType.IsByRef);

        // in: byref + [In] flag + IsReadOnlyAttribute modreq.
        var scale = iface.GetMethod("Scale", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(scale);
        var scaleParam = scale!.GetParameters()[0];
        Assert.Equal("factor", scaleParam.Name);
        Assert.True(scaleParam.ParameterType.IsByRef, "interface in parameter must be ByRef");
        Assert.True(scaleParam.IsIn, "interface in parameter must carry [In]");
        Assert.False(scaleParam.IsOut);
        var modreqs = scaleParam.GetRequiredCustomModifiers();
        Assert.Contains(modreqs, t => t.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute");
    }

    [Fact]
    public void StaticVirtualInterfaceMethod_OutParameter_EmitsByRefFlagAndName()
    {
        const string Source = @"package IfaceSharedMeta
import System

interface IAdd {
    shared {
        func AddInto(a int32, b int32, out result int32);
    }
}

class Adder : IAdd {
    shared {
        func AddInto(a int32, b int32, out result int32) {
            result = a + b
        }
    }
}
";
        var asm = CompileToAssembly(Source, "IfaceSharedMeta");
        var iface = asm.GetTypes().Single(t => t.Name == "IAdd");
        var addInto = iface.GetMethod("AddInto", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(addInto);
        Assert.True(addInto!.IsStatic);
        Assert.True(addInto.IsAbstract);
        var ps = addInto.GetParameters();
        Assert.Equal(3, ps.Length);
        Assert.Equal("a", ps[0].Name);
        Assert.Equal("b", ps[1].Name);
        Assert.Equal("result", ps[2].Name);
        Assert.True(ps[2].ParameterType.IsByRef, "static-virtual out parameter must be ByRef");
        Assert.True(ps[2].IsOut, "static-virtual out parameter must carry [Out]");
    }

    [Fact]
    public void InterfaceMethod_ByValueParameters_KeepNamesInMetadata()
    {
        // The Param-row half of issue #1610: interface parameters were
        // nameless in metadata even without ref kinds, breaking named
        // arguments and IDE signature help from consuming C# projects.
        const string Source = @"package IfaceNames
import System

interface IShape {
    func Area(width int32, height int32) int32;
}

class Rect : IShape {
    func Area(width int32, height int32) int32 {
        return width * height
    }
}
";
        var asm = CompileToAssembly(Source, "IfaceNames");
        var iface = asm.GetTypes().Single(t => t.Name == "IShape");
        var area = iface.GetMethod("Area", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(area);
        var ps = area!.GetParameters();
        Assert.Equal(2, ps.Length);
        Assert.Equal("width", ps[0].Name);
        Assert.Equal("height", ps[1].Name);
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
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

    private static Assembly CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        return loadContext.LoadFromStream(peStream);
    }
}
