// <copyright file="Issue1080NestedTypeNameCollisionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1080: two nested types that share a simple name across DIFFERENT
/// enclosing types — and a nested type whose simple name matches a package-level
/// type — must no longer collide with <c>GS0102</c>. Each retained type must
/// emit as its own CLR (nested) TypeDef, pass ilverify, and run. Follow-up to
/// #1069.
/// </summary>
public class Issue1080NestedTypeNameCollisionEmitTests
{
    [Fact]
    public void SameNestedSimpleName_DifferentOuters_BothEmitAsDistinctNestedTypes()
    {
        var asm = CompileToLibrary("""
            package P

            open class A {
                func Make() int32 {
                    let i = Inner{X: 1}
                    return i.X
                }

                struct Inner { var X int32 }
            }

            open class B {
                func Other() int32 {
                    let j = Probe{Y: 2}
                    return j.Y
                }

                struct Inner { var Z int32 }

                struct Probe { var Y int32 }
            }
            """);

        // Both `Inner` nested structs emit as distinct CLR nested types, each
        // declared in its own enclosing type — they no longer collide (#1080).
        var inners = asm.GetTypes().Where(t => t.Name == "Inner" && t.IsNested).ToList();
        Assert.Equal(2, inners.Count);
        Assert.Contains(inners, t => t.DeclaringType!.Name == "A");
        Assert.Contains(inners, t => t.DeclaringType!.Name == "B");
    }

    [Fact]
    public void PackageLevelType_VersusNestedDataStruct_SameName_BothEmit()
    {
        var asm = CompileToLibrary("""
            package P

            class SampleEntry { var A int32 }

            class SttsBox {
                data struct SampleEntry(FrameCount uint32, FrameDelta uint32) { }
            }
            """);

        var topLevel = asm.GetTypes().Single(t => t.Name == "SampleEntry" && !t.IsNested);
        Assert.Null(topLevel.DeclaringType);

        var nested = asm.GetTypes().Single(t => t.Name == "SampleEntry" && t.IsNested);
        Assert.Equal("SttsBox", nested.DeclaringType!.Name);
    }

    private static Assembly CompileToLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1080_lib_").FullName;
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
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(compileExit == 0, $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        IlVerifier.Verify(outPath);
        return Assembly.Load(File.ReadAllBytes(outPath));
    }
}
