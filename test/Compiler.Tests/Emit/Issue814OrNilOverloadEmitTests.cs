// <copyright file="Issue814OrNilOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #814 / ADR-0084 §L5 closing bullet — emit + IL-verify coverage
/// for the dogfooded <c>SequenceExtensions.FirstOrNil</c> /
/// <c>LastOrNil</c> / <c>SingleOrNil</c> shape: two extension overloads
/// on <c>(self sequence[T])</c>, distinguished only by a
/// <c>[T class]</c> / <c>[T struct]</c> generic-parameter constraint and
/// a return-type representation that bottoms out in <c>T?</c>. The
/// binder must pick the right overload; the emitter must close the open
/// <c>T?</c> return into a reference <c>T</c> on the class side and into
/// <c>Nullable&lt;T&gt;</c> on the struct side; the produced IL must
/// verify under <c>ilverify</c>.
/// </summary>
public class Issue814OrNilOverloadEmitTests
{
    [Fact]
    public void FirstOrNil_TwoOverloads_ClassReceiver_StringArray_PicksClassOverload()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func (self sequence[T]) FirstOrNil[T class]() string { return "class" }
            func (self sequence[T]) FirstOrNil[T struct]() string { return "struct" }

            public var tag = ""
            tag = ([]string{"a", "b"}).FirstOrNil()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("class", GetStringField(assembly, "tag"));
    }

    [Fact]
    public void FirstOrNil_TwoOverloads_StructReceiver_Int32Array_PicksStructOverload()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func (self sequence[T]) FirstOrNil[T class]() string { return "class" }
            func (self sequence[T]) FirstOrNil[T struct]() string { return "struct" }

            public var tag = ""
            tag = ([]int32{1, 2}).FirstOrNil()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("struct", GetStringField(assembly, "tag"));
    }

    [Fact]
    public void FirstOrNil_TQuestionReturn_ClassReceiver_StringArray_ReturnsHead()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func (self sequence[T]) FirstOrNil[T class]() T? {
                for v in self { return v }
                return nil
            }

            func (self sequence[T]) FirstOrNil[T struct]() T? {
                for v in self { return v }
                return nil
            }

            public var head = ""
            head = ([]string{"alpha", "beta"}).FirstOrNil() ?? "<none>"
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("alpha", GetStringField(assembly, "head"));
    }

    [Fact]
    public void FirstOrNil_TQuestionReturn_StructReceiver_Int32Array_ReturnsHead()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func (self sequence[T]) FirstOrNil[T class]() T? {
                for v in self { return v }
                return nil
            }

            func (self sequence[T]) FirstOrNil[T struct]() T? {
                for v in self { return v }
                return nil
            }

            public var head = 0
            head = ([]int32{11, 22, 33}).FirstOrNil() ?? -1
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(11, GetIntField(assembly, "head"));
    }

    [Fact]
    public void FirstOrNil_TQuestionReturn_EmptyStringArray_ReturnsNil()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func (self sequence[T]) FirstOrNil[T class]() T? {
                for v in self { return v }
                return nil
            }

            func (self sequence[T]) FirstOrNil[T struct]() T? {
                for v in self { return v }
                return nil
            }

            public var head = ""
            head = ([]string{}).FirstOrNil() ?? "<none>"
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("<none>", GetStringField(assembly, "head"));
    }

    [Fact]
    public void FirstOrNil_TQuestionReturn_EmptyInt32Array_ReturnsNil()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func (self sequence[T]) FirstOrNil[T class]() T? {
                for v in self { return v }
                return nil
            }

            func (self sequence[T]) FirstOrNil[T struct]() T? {
                for v in self { return v }
                return nil
            }

            public var head = 0
            head = ([]int32{}).FirstOrNil() ?? -1
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(-1, GetIntField(assembly, "head"));
    }

    [Fact]
    public void LastOrNil_TQuestionReturn_BothShapes_RunCorrectly()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func (self sequence[T]) LastOrNil[T class]() T? {
                var last T? = nil
                for v in self { last = v }
                return last
            }

            func (self sequence[T]) LastOrNil[T struct]() T? {
                var last T? = nil
                for v in self { last = v }
                return last
            }

            public var sLast = ""
            public var nLast = 0
            sLast = ([]string{"a", "b", "c"}).LastOrNil() ?? "<none>"
            nLast = ([]int32{10, 20, 30}).LastOrNil() ?? -1
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("c", GetStringField(assembly, "sLast"));
        Assert.Equal(30, GetIntField(assembly, "nLast"));
    }

    [Fact]
    public void SingleOrNil_TQuestionReturn_BothShapes_RunCorrectly()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func (self sequence[T]) SingleOrNil[T class]() T? {
                var only T? = nil
                var count = 0
                for v in self {
                    only = v
                    count = count + 1
                }
                if count == 1 { return only }
                return nil
            }

            func (self sequence[T]) SingleOrNil[T struct]() T? {
                var only T? = nil
                var count = 0
                for v in self {
                    only = v
                    count = count + 1
                }
                if count == 1 { return only }
                return nil
            }

            public var sSolo = ""
            public var nSolo = 0
            public var sNone = ""
            sSolo = ([]string{"x"}).SingleOrNil() ?? "<none>"
            nSolo = ([]int32{42}).SingleOrNil() ?? -1
            sNone = ([]string{"a", "b"}).SingleOrNil() ?? "<none>"
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("x", GetStringField(assembly, "sSolo"));
        Assert.Equal(42, GetIntField(assembly, "nSolo"));
        Assert.Equal("<none>", GetStringField(assembly, "sNone"));
    }

    #region Helpers

    private static Assembly CompileAndRun(string source)
    {
        var outPath = CompileToFile(source, target: "exe");
        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        return assembly;
    }

    private static string CompileToFile(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_814_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static int GetIntField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (int)field!.GetValue(null)!;
    }

    private static string GetStringField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (string)field!.GetValue(null)!;
    }

    #endregion
}
