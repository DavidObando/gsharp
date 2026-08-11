// <copyright file="Issue3095AwaitedReadOnlyListLinqEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Runtime and ILVerify coverage for async call metadata preservation.</summary>
public sealed class Issue3095AwaitedReadOnlyListLinqEmitTests
{
    [Fact]
    public void AwaitedReadOnlyList_WhereToList_ControlsRunAndVerify()
    {
        const string source = """
            package Issue3095.Basic

            import System
            import System.Collections.Generic
            import System.Linq
            import System.Threading.Tasks

            data class Notice3095(Active bool) {}

            interface IStore3095 {
                func ListAsync() Task[IReadOnlyList[Notice3095]];
                func List() IReadOnlyList[Notice3095];
            }

            class Store3095 : IStore3095 {
                public async func ListAsync() IReadOnlyList[Notice3095] {
                    await Task.Yield()
                    return []Notice3095{Notice3095(true), Notice3095(false), Notice3095(true)}
                }

                public func List() IReadOnlyList[Notice3095] ->
                    []Notice3095{Notice3095(true), Notice3095(false), Notice3095(true)}
            }

            async func DirectAwaited(Store IStore3095) List[Notice3095] {
                return (await Store.ListAsync())
                    .Where((item Notice3095) -> item.Active)
                    .ToList()
            }

            async func AwaitedLocal(Store IStore3095) List[Notice3095] {
                let items = await Store.ListAsync()
                return items.Where((item Notice3095) -> item.Active).ToList()
            }

            func LocalListControl() List[Notice3095] {
                let items = List[Notice3095]{
                    Notice3095(true),
                    Notice3095(false),
                    Notice3095(true),
                }
                return items.Where((item Notice3095) -> item.Active).ToList()
            }

            func InterfaceListControl(Store IStore3095) List[Notice3095] {
                let items = Store.List()
                return items.Where((item Notice3095) -> item.Active).ToList()
            }

            let Store IStore3095 = Store3095()
            let direct = DirectAwaited(Store).GetAwaiter().GetResult()
            Console.WriteLine(direct.Count)
            Console.WriteLine(direct[0].Active)
            Console.WriteLine(direct[1].Active)
            Console.WriteLine(AwaitedLocal(Store).GetAwaiter().GetResult().Count)
            Console.WriteLine(LocalListControl().Count)
            Console.WriteLine(InterfaceListControl(Store).Count)
            """;

        Assert.Equal($"2{Environment.NewLine}True{Environment.NewLine}True{Environment.NewLine}2{Environment.NewLine}2{Environment.NewLine}2{Environment.NewLine}", CompileVerifyAndRun(source));
    }

    [Fact]
    public void AwaitedReadOnlyList_PreservesCovariantAndNestedGenericArguments()
    {
        const string source = """
            package Issue3095.Siblings

            import System
            import System.Collections.Generic
            import System.IO
            import System.Linq
            import System.Threading.Tasks

            data class Leaf3095(Value int32) {}

            interface ISiblingStore3095 {
                func StreamsAsync() Task[IReadOnlyList[MemoryStream]];
                func GroupsAsync() Task[IReadOnlyList[List[Leaf3095]]];
            }

            class SiblingStore3095 : ISiblingStore3095 {
                public async func StreamsAsync() IReadOnlyList[MemoryStream] {
                    await Task.Yield()
                    return []MemoryStream{MemoryStream(), MemoryStream()}
                }

                public async func GroupsAsync() IReadOnlyList[List[Leaf3095]] {
                    await Task.Yield()
                    return []List[Leaf3095]{
                        List[Leaf3095]{Leaf3095(1), Leaf3095(2)},
                        List[Leaf3095]{Leaf3095(3)},
                    }
                }
            }

            async func Covariant(Store ISiblingStore3095) IEnumerable[Stream] {
                return (await Store.StreamsAsync())
                    .Where((stream MemoryStream) -> stream.CanRead)
                    .ToList()
            }

            async func Nested(Store ISiblingStore3095) List[List[Leaf3095]] {
                return (await Store.GroupsAsync())
                    .Where((group List[Leaf3095]) -> group.Count > 1)
                    .ToList()
            }

            let Store ISiblingStore3095 = SiblingStore3095()
            Console.WriteLine(Covariant(Store).GetAwaiter().GetResult().Count())
            let nested = Nested(Store).GetAwaiter().GetResult()
            Console.WriteLine(nested.Count)
            Console.WriteLine(nested[0][1].Value)
            """;

        Assert.Equal($"2{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}", CompileVerifyAndRun(source));
    }

    [Fact]
    public void UserInstanceCalls_WithoutAwait_RunAndVerify()
    {
        const string source = """
            package Issue3095.UserInstanceControls

            import System

            interface ICmp3095Control[T] {
                func CompareTo(other T) int32;
            }

            struct Score3095Control : ICmp3095Control[Score3095Control] {
                var Value int32

                func CompareTo(other Score3095Control) int32 {
                    return Value - other.Value
                }
            }

            class Marker3095Control {
                func Mark[T](value int32) string {
                    return "mark:" + value.ToString()
                }
            }

            func CompareDirect[T ICmp3095Control[T]](left T, right T) int32 {
                return left.CompareTo(right)
            }

            let left = Score3095Control{Value: 9}
            let right = Score3095Control{Value: 4}
            Console.WriteLine(CompareDirect[Score3095Control](left, right))
            Console.WriteLine(Marker3095Control().Mark[string](3))
            """;

        Assert.Equal($"5{Environment.NewLine}mark:3{Environment.NewLine}", CompileVerifyAndRun(source));
    }

    [Fact]
    public void AwaitedConstrainedUserInstanceCall_PreservesDispatchMetadata()
    {
        const string source = """
            package Issue3095.AwaitedConstrainedUserInstance

            import System
            import System.Threading.Tasks

            interface ICmp3095Await[T] {
                func CompareTo(other T) int32;
            }

            struct Score3095Await : ICmp3095Await[Score3095Await] {
                var Value int32

                func CompareTo(other Score3095Await) int32 {
                    return Value - other.Value
                }
            }

            async func CompareAwaited[T ICmp3095Await[T]](left T, right Task[T]) int32 {
                return left.CompareTo(await right)
            }

            let left = Score3095Await{Value: 9}
            let right = Score3095Await{Value: 4}
            let result = CompareAwaited[Score3095Await](
                left,
                Task.FromResult[Score3095Await](right)).GetAwaiter().GetResult()
            Console.WriteLine(result)
            """;

        Assert.Equal($"5{Environment.NewLine}", CompileVerifyAndRun(source));
    }

    [Fact]
    public void AwaitedGenericUserInstanceCall_PreservesMethodTypeArguments()
    {
        const string source = """
            package Issue3095.AwaitedGenericUserInstance

            import System
            import System.Threading.Tasks

            class Marker3095Await {
                func Mark[T](value int32) string {
                    return "mark:" + value.ToString()
                }
            }

            async func MarkAwaited(marker Marker3095Await, value Task[int32]) string {
                return marker.Mark[string](await value)
            }

            let result = MarkAwaited(
                Marker3095Await(),
                Task.FromResult[int32](7)).GetAwaiter().GetResult()
            Console.WriteLine(result)
            """;

        Assert.Equal($"mark:7{Environment.NewLine}", CompileVerifyAndRun(source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3095_").FullName;
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
