// <copyright file="Issue3096CollectionSpreadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Runtime and ILVerify coverage for native initializer-safe spreads.</summary>
public sealed class Issue3096CollectionSpreadEmitTests
{
    [Fact]
    public void FieldPropertyAndCollectionSpreads_RunAndVerify()
    {
        const string Source = """
            package Issue3096

            import System
            import System.Collections.Generic
            import System.Linq

            data class Item(Value string) {}

            func Copy[T any](source []T) []T {
                return []T{ ...source }
            }

            func CountWithPrefix(prefix int32, values []int32) int32 {
                return prefix + values.Length
            }

            func CopySpan(source Span[int32]) []int32 {
                return []int32{ ...source }
            }

            interface IStaticValues {
                shared {
                    var Count int32 = []int32{ 6, ...[]int32{ 7 } }.Length
                }
            }

            class Holder {
                public let Instance []string = []string{ "instance-head", ...[]string{}, "instance-tail" }
                public let Collection List[string] = List[string](){ "collection-head", ...[]string{ "collection-middle" }, "collection-tail" }
                public prop Property []string { get; init; }

                init() {
                    Property = []string{ "property-head", ...[]string{}, "property-tail" }
                }

                shared {
                    public var Calls int32 = 0
                    public var Trace string = ""
                    public let All []string = []string{ "a", "b", "skip" }
                    public let Filtered []string = []string{ ...All.Where((x string) -> x != "skip") }
                    public let Ordered []string = []string{ Mark("head", "A"), ...Source(), Mark("tail", "C") }
                    public let Empty []string = []string{ ...[]string{} }
                    public let Mixed []string = []string{ "before", ...Filtered, ...Empty, "after" }

                    func Mark(value string, marker string) string {
                        Trace = Trace + marker
                        return value
                    }

                    func Source() []string {
                        Calls++
                        Trace = Trace + "B"
                        return []string{ "middle-1", "middle-2" }
                    }
                }
            }

            let holder = Holder()
            let list = List[string](){ "list-head", ...Holder.Filtered, "list-tail" }
            let copied = Copy([]Item{ Item("user") })
            let spanCopy = CopySpan([]int32{ 8, 9 })
            let pairs = []KeyValuePair[string, int32]{ KeyValuePair[string, int32]("key", 42) }
            let dictionary = Dictionary[string, int32](){ ...pairs }

            Console.WriteLine(Holder.Filtered.Length)
            Console.WriteLine(Holder.Filtered[0])
            Console.WriteLine(Holder.Filtered[1])
            Console.WriteLine(Holder.Ordered.Length)
            Console.WriteLine(Holder.Ordered[0])
            Console.WriteLine(Holder.Ordered[1])
            Console.WriteLine(Holder.Ordered[2])
            Console.WriteLine(Holder.Ordered[3])
            Console.WriteLine(Holder.Trace)
            Console.WriteLine(Holder.Calls)
            Console.WriteLine(Holder.Empty.Length)
            Console.WriteLine(Holder.Mixed.Length)
            Console.WriteLine(holder.Instance.Length)
            Console.WriteLine(holder.Collection.Count)
            Console.WriteLine(holder.Property.Length)
            Console.WriteLine(list.Count)
            Console.WriteLine(copied[0].Value)
            Console.WriteLine(CountWithPrefix(10, []int32{ ...[]int32{ 1, 2 } }))
            Console.WriteLine(spanCopy[1])
            Console.WriteLine(IStaticValues.Count)
            Console.WriteLine(dictionary["key"])
            """;

        Assert.Equal(
            $"2{Environment.NewLine}a{Environment.NewLine}b{Environment.NewLine}4{Environment.NewLine}head{Environment.NewLine}middle-1{Environment.NewLine}middle-2{Environment.NewLine}tail{Environment.NewLine}ABC{Environment.NewLine}1{Environment.NewLine}0{Environment.NewLine}4{Environment.NewLine}2{Environment.NewLine}3{Environment.NewLine}2{Environment.NewLine}4{Environment.NewLine}user{Environment.NewLine}12{Environment.NewLine}9{Environment.NewLine}2{Environment.NewLine}42{Environment.NewLine}",
            CompileVerifyAndRun(Source));
    }

    [Fact]
    public void FaultedStaticSpreadInitializer_ThrowsTypeInitializationExceptionOnce()
    {
        const string Source = """
            package Issue3096.Fault

            import System

            var Attempts = 0

            class Broken {
                shared {
                    let Values []int32 = []int32{ ...Fail() }

                    func Fail() []int32 {
                        Attempts++
                        throw InvalidOperationException("boom")
                    }
                }
            }

            func Read() {
                try {
                    let ignored = Broken.Values
                } catch (ex TypeInitializationException) {
                    Console.WriteLine(ex.InnerException is InvalidOperationException)
                }
            }

            Read()
            Read()
            Console.WriteLine(Attempts)
            """;

        Assert.Equal($"True{Environment.NewLine}True{Environment.NewLine}1{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    [Fact]
    public void UserDefinedSpreadConversions_ArrayAndCollection_RunAndVerify()
    {
        const string Source = """
            package Issue3096.Conversions

            import System
            import System.Collections.Generic

            struct Celsius {
                var Degrees float64
            }

            func operator implicit(value Celsius) float64 {
                return value.Degrees
            }

            let source = []Celsius{
                Celsius{ Degrees: 2.5 },
                Celsius{ Degrees: 3.5 },
            }
            let array = []float64{ 1.0, ...source, 9.0 }
            let list = List[float64](){ ...source }

            Console.WriteLine(array.Length)
            Console.WriteLine(array[1])
            Console.WriteLine(array[2])
            Console.WriteLine(list.Count)
            Console.WriteLine(list[0])
            Console.WriteLine(list[1])
            """;

        Assert.Equal(
            $"4{Environment.NewLine}2.5{Environment.NewLine}3.5{Environment.NewLine}2{Environment.NewLine}2.5{Environment.NewLine}3.5{Environment.NewLine}",
            CompileVerifyAndRun(Source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3096_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed:{Environment.NewLine}{stdout}{stderr}");
            IlVerifier.Verify(outputPath);

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                    outputPath,
                },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            }) ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"exited {process.ExitCode}:{Environment.NewLine}{error}");
            return output.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
