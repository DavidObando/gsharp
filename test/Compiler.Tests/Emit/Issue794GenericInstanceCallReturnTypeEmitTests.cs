// <copyright file="Issue794GenericInstanceCallReturnTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #794 end-to-end coverage. The binder fix re-projects the
/// receiver's symbolic type arguments through instance calls and
/// property reads on imported CLR generics. These tests round-trip
/// each scenario through compile → IL-verify → run so we catch any
/// emit-time regression in the type-erased generic dispatch path
/// (ADR-0087 R1–R5 / #313 / #671 / #765).
/// </summary>
public class Issue794GenericInstanceCallReturnTypeEmitTests
{
    [Fact]
    public void ListT_ToArray_From_Generic_Shared_Roundtrips_Int32()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Sequences {
                shared {
                    func MakeList[T any](v T) []T {
                        var list = List[T]()
                        list.Add(v)
                        list.Add(v)
                        return list.ToArray()
                    }
                }
            }

            var arr = Sequences.MakeList[int32](42)
            Console.WriteLine(arr.Length)
            Console.WriteLine(arr[0])
            Console.WriteLine(arr[1])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n42\n42\n", output);
    }

    [Fact]
    public void ListT_ToArray_From_Generic_Shared_Roundtrips_String()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Sequences {
                shared {
                    func MakeList[T any](v T) []T {
                        var list = List[T]()
                        list.Add(v)
                        return list.ToArray()
                    }
                }
            }

            var arr = Sequences.MakeList[string]("hi")
            Console.WriteLine(arr.Length)
            Console.WriteLine(arr[0])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\nhi\n", output);
    }

    [Fact]
    public void ListT_Count_From_Generic_Shared_Returns_Int32()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Sequences {
                shared {
                    func CountThree[T any](v T) int32 {
                        var list = List[T]()
                        list.Add(v)
                        list.Add(v)
                        list.Add(v)
                        return list.Count
                    }
                }
            }

            Console.WriteLine(Sequences.CountThree[int32](0))
            Console.WriteLine(Sequences.CountThree[string](""))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n3\n", output);
    }

    [Fact]
    public void ListT_Add_With_TypeParameter_Argument_Inside_Generic_TopLevel_Func()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            func MakeAndCount[T any](a T, b T) int32 {
                var list = List[T]()
                list.Add(a)
                list.Add(b)
                return list.Count
            }

            Console.WriteLine(MakeAndCount[int32](1, 2))
            Console.WriteLine(MakeAndCount[string]("x", "y"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n2\n", output);
    }

    [Fact]
    public void DictionaryKV_Keys_Iterated_Returns_K()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Helper {
                shared {
                    func FirstOrFallback[K any, V any](fb K, seed V) K {
                        var dict = Dictionary[K, V]()
                        dict.Add(fb, seed)
                        for k in dict.Keys {
                            return k
                        }
                        return fb
                    }
                }
            }

            Console.WriteLine(Helper.FirstOrFallback[string, int32]("fallback", 0))
            Console.WriteLine(Helper.FirstOrFallback[int32, string](-1, ""))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("fallback\n-1\n", output);
    }

    [Fact]
    public void Generic_Extension_Method_With_ListT_ToArray_Roundtrip()
    {
        // Cross-check #773: an extension whose receiver is `[]T` calls
        // through to `List[T]().ToArray()` and must thread the same `T`.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (self []T) DoubleViaList[T]() []T {
                var list = List[T]()
                for v in self {
                    list.Add(v)
                    list.Add(v)
                }
                return list.ToArray()
            }

            var arr = []int32{1, 2}
            var doubled = arr.DoubleViaList()
            Console.WriteLine(doubled.Length)
            Console.WriteLine(doubled[0])
            Console.WriteLine(doubled[3])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n1\n2\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue794_emit_").FullName;
        try
        {
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
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
