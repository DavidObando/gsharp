// <copyright file="Issue3095AwaitedReadOnlyListLinqEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Runtime and ILVerify coverage for issue #3095.</summary>
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

        Assert.Equal("2\nTrue\nTrue\n2\n2\n2\n", CompileVerifyAndRun(source));
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

        Assert.Equal("2\n1\n2\n", CompileVerifyAndRun(source));
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
            return output.Replace("\r\n", "\n", StringComparison.Ordinal);
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
