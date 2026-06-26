// <copyright file="Issue710NullConditionalIndexingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #710 / ADR-0073 — emit coverage for the new <c>a?[i]</c>
/// null-conditional indexing operator. Each test compiles via in-process
/// <c>gsc</c>, IL-verifies the emitted PE, and runs it under
/// <c>dotnet exec</c>, asserting captured stdout. Covers slices, maps,
/// CLR indexers, and the receiver-evaluated-once invariant.
/// </summary>
public class Issue710NullConditionalIndexingEmitTests
{
    [Fact]
    public void Slice_NullReceiver_YieldsNil()
    {
        var source = """
            package Test
            import System

            func main() {
                var a ([]int32)? = nil
                var x = a?[0]
                if x == nil {
                    Console.WriteLine("nil")
                } else {
                    Console.WriteLine("notnil")
                }
            }

            main()
            """;

        Assert.Equal("nil\n", CompileAndRun(source));
    }

    [Fact]
    public void Slice_NonNullReceiver_YieldsLiftedValue()
    {
        var source = """
            package Test
            import System

            func main() {
                var a ([]int32)? = []int32{10, 20, 30}
                var x = a?[1]
                Console.WriteLine(x)
            }

            main()
            """;

        Assert.Equal("20\n", CompileAndRun(source));
    }

    [Fact]
    public void Map_NullReceiver_YieldsNil()
    {
        var source = """
            package Test
            import System
            import System.Collections.Generic

            func main() {
                var d Dictionary[string, int32]? = nil
                var v = d?["k"]
                if v == nil {
                    Console.WriteLine("nil")
                } else {
                    Console.WriteLine("notnil")
                }
            }

            main()
            """;

        Assert.Equal("nil\n", CompileAndRun(source));
    }

    [Fact]
    public void Map_NonNullReceiver_YieldsLiftedValue()
    {
        var source = """
            package Test
            import System
            import System.Collections.Generic

            func main() {
                var d Dictionary[string, int32]? = Dictionary[string, int32]()
                d.Add("a", 100)
                d.Add("b", 200)
                var v = d?["a"]
                Console.WriteLine(v)
            }

            main()
            """;

        Assert.Equal("100\n", CompileAndRun(source));
    }

    [Fact]
    public void StringIndexer_ReferenceTypedResult_PropagatesNil()
    {
        // String[int] is a CLR indexer returning char. Use a Dictionary
        // returning string to exercise a reference-typed result through
        // `?[]` and confirm both the nil and non-nil paths.
        var source = """
            package Test
            import System
            import System.Collections.Generic

            func main() {
                var d Dictionary[string, string]? = Dictionary[string, string]()
                d.Add("hi", "world")
                Console.WriteLine(d?["hi"])

                var d2 Dictionary[string, string]? = nil
                var v = d2?["hi"]
                if v == nil {
                    Console.WriteLine("nil")
                }
            }

            main()
            """;

        Assert.Equal("world\nnil\n", CompileAndRun(source));
    }

    [Fact]
    public void Receiver_EvaluatedOnce_WhenNonNull()
    {
        // The receiver function is called once per `?[...]` site whether
        // or not it returns nil. The index sub-expression must not be
        // evaluated when the receiver is nil.
        var source = """
            package Test
            import System

            var receiverCalls int32 = 0
            var indexCalls int32 = 0

            func getSlice() ([]int32)? {
                receiverCalls = receiverCalls + 1
                return []int32{7, 8, 9}
            }

            func getNilSlice() ([]int32)? {
                receiverCalls = receiverCalls + 1
                return nil
            }

            func getIndex() int32 {
                indexCalls = indexCalls + 1
                return 1
            }

            func main() {
                // Non-nil receiver: receiver + 1, index + 1, value = 8.
                var x = getSlice()?[getIndex()]
                Console.WriteLine(x)
                Console.WriteLine(receiverCalls)
                Console.WriteLine(indexCalls)

                // Nil receiver: receiver + 1, index NOT evaluated, value = nil.
                var y = getNilSlice()?[getIndex()]
                if y == nil {
                    Console.WriteLine("nil")
                }
                Console.WriteLine(receiverCalls)
                Console.WriteLine(indexCalls)
            }

            main()
            """;

        // After the first `?[]`: receiver=1, index=1, x=8.
        // After the second `?[]`: receiver=2, index still 1, y=nil.
        Assert.Equal("8\n1\n1\nnil\n2\n1\n", CompileAndRun(source));
    }

    [Fact]
    public void Chained_NullConditional_Member_Then_Index()
    {
        // `h?.Data?[0]` short-circuits at either segment.
        var source = """
            package Test
            import System

            class Holder {
                var Data ([]int32)?
            }

            func main() {
                var h Holder? = Holder{Data: []int32{1, 2, 3}}
                var v = h?.Data?[1]
                Console.WriteLine(v)

                var hNoData Holder? = Holder{Data: nil}
                var v2 = hNoData?.Data?[0]
                if v2 == nil {
                    Console.WriteLine("nil-data")
                }

                var hNil Holder? = nil
                var v3 = hNil?.Data?[0]
                if v3 == nil {
                    Console.WriteLine("nil-holder")
                }
            }

            main()
            """;

        Assert.Equal("2\nnil-data\nnil-holder\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue710_").FullName;
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
                "/nowarn:GS9100",
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
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
