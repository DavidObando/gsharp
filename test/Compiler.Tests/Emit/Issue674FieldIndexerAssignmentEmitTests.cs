// <copyright file="Issue674FieldIndexerAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #674: assigning through an indexer rooted on a class field
/// (<c>field[i] = v</c>) triggered GS9998 "Variable has no local slot" at
/// emit time. The binder was passing the raw <c>ImplicitFieldVariableSymbol</c>
/// to the index-assignment node, but the emitter only recognises locals,
/// parameters, and globals. The fix rewrites the bare-field-name target into
/// a synthesized temp local initialized from a proper <c>this</c>-rooted
/// field access expression, paralleling what the member-index-assignment
/// path already does.
/// </summary>
public class Issue674FieldIndexerAssignmentEmitTests
{
    [Fact]
    public void ListField_IndexAssignment_Works()
    {
        // The exact repro from the issue: items[i] = b inside a class method.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Bag class {
                items List[int32] = List[int32]()

                func Add(v int32) {
                    items.Add(v)
                }

                func Swap(i int32, j int32) {
                    var a = items[i]
                    var b = items[j]
                    items[i] = b
                    items[j] = a
                }

                func Get(i int32) int32 {
                    return items[i]
                }
            }

            var bag = Bag()
            bag.Add(10)
            bag.Add(20)
            bag.Add(30)
            bag.Swap(0, 2)
            Console.WriteLine(bag.Get(0))
            Console.WriteLine(bag.Get(2))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("30\n10\n", output);
    }

    [Fact]
    public void DictionaryField_IndexAssignment_Works()
    {
        // Dictionary[string, int32] field write: dict["x"] = 1.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Cache class {
                data Dictionary[string, int32] = Dictionary[string, int32]()

                func Set(key string, value int32) {
                    data[key] = value
                }

                func Get(key string) int32 {
                    return data[key]
                }
            }

            var c = Cache()
            c.Set("hello", 42)
            c.Set("world", 99)
            Console.WriteLine(c.Get("hello"))
            Console.WriteLine(c.Get("world"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n99\n", output);
    }

    [Fact]
    public void ArrayField_IndexAssignment_Works()
    {
        // gsharp slice ([]int32) field write: arr[i] = v.
        var source = """
            package P
            import System

            type Container class {
                arr []int32 = []int32{0, 0, 0, 0, 0}

                func Set(i int32, v int32) {
                    arr[i] = v
                }

                func Get(i int32) int32 {
                    return arr[i]
                }
            }

            var c = Container()
            c.Set(0, 100)
            c.Set(4, 400)
            Console.WriteLine(c.Get(0))
            Console.WriteLine(c.Get(4))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("100\n400\n", output);
    }

    [Fact]
    public void FieldIndexAssignment_InsideInit_Works()
    {
        // Index assignment on a field inside an init() constructor body.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Holder class {
                items List[int32] = List[int32]()

                init() {
                    items.Add(0)
                    items.Add(0)
                    items[0] = 77
                    items[1] = 88
                }

                func Get(i int32) int32 {
                    return items[i]
                }
            }

            var h = Holder()
            Console.WriteLine(h.Get(0))
            Console.WriteLine(h.Get(1))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("77\n88\n", output);
    }

    [Fact]
    public void FieldIndexAssignment_MultipleFieldsSameClass_Works()
    {
        // Multiple different fields with indexer writes in the same method.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Multi class {
                names List[string] = List[string]()
                scores List[int32] = List[int32]()

                init() {
                    names.Add("a")
                    names.Add("b")
                    scores.Add(0)
                    scores.Add(0)
                }

                func Update(i int32, name string, score int32) {
                    names[i] = name
                    scores[i] = score
                }

                func GetName(i int32) string {
                    return names[i]
                }

                func GetScore(i int32) int32 {
                    return scores[i]
                }
            }

            var m = Multi()
            m.Update(0, "Alice", 95)
            m.Update(1, "Bob", 87)
            Console.WriteLine(m.GetName(0))
            Console.WriteLine(m.GetScore(1))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Alice\n87\n", output);
    }

    [Fact]
    public void FieldIndexAssignment_ReadAndWriteSameStatement_Works()
    {
        // Read from field index and write to field index in same expression context.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Acc class {
                vals List[int32] = List[int32]()

                init() {
                    vals.Add(10)
                    vals.Add(20)
                }

                func Double(i int32) {
                    vals[i] = vals[i] + vals[i]
                }

                func Get(i int32) int32 {
                    return vals[i]
                }
            }

            var a = Acc()
            a.Double(0)
            a.Double(1)
            Console.WriteLine(a.Get(0))
            Console.WriteLine(a.Get(1))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("20\n40\n", output);
    }

    [Fact]
    public void FieldIndexAssignment_CompoundPlusEquals_Works()
    {
        // Compound assignment: items[i] += v on a field.
        var source = """
            package P
            import System
            import System.Collections.Generic

            type Counter class {
                counts List[int32] = List[int32]()

                init() {
                    counts.Add(0)
                    counts.Add(0)
                    counts.Add(0)
                }

                func Increment(i int32, amount int32) {
                    counts[i] += amount
                }

                func Get(i int32) int32 {
                    return counts[i]
                }
            }

            var c = Counter()
            c.Increment(0, 5)
            c.Increment(0, 3)
            c.Increment(2, 10)
            Console.WriteLine(c.Get(0))
            Console.WriteLine(c.Get(2))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("8\n10\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue674_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
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

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
