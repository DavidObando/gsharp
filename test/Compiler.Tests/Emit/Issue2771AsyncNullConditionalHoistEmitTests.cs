// <copyright file="Issue2771AsyncNullConditionalHoistEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2771: emitter-owned null-conditional capture stores must target
/// state-machine fields when async lowering hoists those captures.
/// </summary>
public class Issue2771AsyncNullConditionalHoistEmitTests
{
    public static IEnumerable<object[]> RuntimeMatrix()
    {
        yield return Case(
            "method, null and non-null receivers, ConfigureAwait, before and after await",
            """
            class Svc {
                async func Tick() Task[bool] {
                    await Task.Yield()
                    return true
                }
            }

            class Runner {
                async func Run(raw string?) Task[string] {
                    let value string? = raw?.Trim()
                    let before = value ?? "nil"
                    let ok = await Svc().Tick().ConfigureAwait(false)
                    return before + ":" + (value ?? "nil") + ":" + ok.ToString()
                }
            }

            let runner = Runner()
            Console.WriteLine(runner.Run("  method  ").Result)
            Console.WriteLine(runner.Run(nil).Result)
            """,
            "method:method:True\nnil:nil:True\n");

        yield return Case(
            "property with nullable value result",
            """
            class Runner {
                async func Run(raw string?) Task[int32] {
                    let length int32? = raw?.Length
                    let before = length ?? 0
                    await Task.Delay(1)
                    return before + (length ?? 0)
                }
            }

            let runner = Runner()
            Console.WriteLine(runner.Run("four").Result)
            Console.WriteLine(runner.Run(nil).Result)
            """,
            "8\n0\n");

        yield return Case(
            "property with nullable reference result",
            """
            class Box {
                private let text string?

                init(text string?) {
                    this.text = text
                }

                prop Text string? {
                    get { return this.text }
                }
            }

            class Runner {
                async func Run(box Box?) Task[string] {
                    let text string? = box?.Text
                    await Task.Yield()
                    return text ?? "none"
                }
            }

            let runner = Runner()
            Console.WriteLine(runner.Run(Box("property")).Result)
            Console.WriteLine(runner.Run(nil).Result)
            """,
            "property\nnone\n");

        yield return Case(
            "loop preserves each conditional local",
            """
            class Runner {
                async func Run(items []string) Task[int32] {
                    var total = 0
                    for raw in items {
                        let value string? = raw?.Trim()
                        await Task.Yield()
                        if value != nil {
                            total = total + value!!.Length
                        }
                    }

                    return total
                }
            }

            Console.WriteLine(Runner().Run([]string{" a ", "bc", ""}).Result)
            """,
            "3\n");

        yield return Case(
            "async closure preserves method result",
            """
            class Nav {
                private let label string

                init(label string) {
                    this.label = label
                }

                func Label() string {
                    return this.label
                }
            }

            class Runner {
                func Run(nav Nav?) Task[string] {
                    return Task.Run(async () -> {
                        let label string? = nav?.Label()
                        await Task.Delay(1).ConfigureAwait(false)
                        return label ?? "none"
                    })
                }
            }

            let runner = Runner()
            Console.WriteLine(runner.Run(Nav("closure")).Result)
            Console.WriteLine(runner.Run(nil).Result)
            """,
            "closure\nnone\n");

        yield return Case(
            "plain nullable and await-free controls",
            """
            class Runner {
                async func Plain(raw string?) Task[string] {
                    let value = raw
                    await Task.Yield()
                    return value ?? "none"
                }

                func ConditionalWithoutAwait(raw string?) string {
                    let value string? = raw?.Trim()
                    return value ?? "none"
                }
            }

            let runner = Runner()
            Console.WriteLine(runner.Plain("plain").Result)
            Console.WriteLine(runner.Plain(nil).Result)
            Console.WriteLine(runner.ConditionalWithoutAwait(" control "))
            Console.WriteLine(runner.ConditionalWithoutAwait(nil))
            """,
            "plain\nnone\ncontrol\nnone\n");
    }

    [Theory]
    [MemberData(nameof(RuntimeMatrix))]
    public void NullConditionalMatrix_VerifiesAndRuns(string _, string body, string expected)
    {
        Assert.Equal(expected, CompileVerifyAndRun(Wrap(body)));
    }

    [Fact]
    public void HoistedFields_PreserveNullableIdentity()
    {
        var source = Wrap(
            """
            class Runner {
                async func Ref(raw string?) Task[string?] {
                    let value string? = raw?.Trim()
                    await Task.Yield()
                    return value
                }

                async func Val(raw string?) Task[int32?] {
                    let value int32? = raw?.Length
                    await Task.Yield()
                    return value
                }
            }
            """);

        var (directory, outputPath) = Compile(source);
        try
        {
            IlVerifier.Verify(outputPath);
            var loadContext = new AssemblyLoadContext("Issue2771FieldShape", isCollectible: true);
            try
            {
                var assembly = loadContext.LoadFromAssemblyPath(outputPath);
                var stateMachines = assembly.GetTypes()
                    .Where(type => type.Name.Contains("d__", StringComparison.Ordinal))
                    .ToArray();
                var refMachine = Assert.Single(stateMachines, type => type.Name.Contains("<Ref>", StringComparison.Ordinal));
                var valMachine = Assert.Single(stateMachines, type => type.Name.Contains("<Val>", StringComparison.Ordinal));

                Assert.Contains(
                    refMachine.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                    field => field.Name.Contains("<value>5__", StringComparison.Ordinal)
                        && field.FieldType == typeof(string));
                Assert.Contains(
                    refMachine.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                    field => field.Name.Contains("<$ncap_", StringComparison.Ordinal)
                        && field.FieldType == typeof(string));
                Assert.Contains(
                    valMachine.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                    field => field.Name.Contains("<value>5__", StringComparison.Ordinal)
                        && field.FieldType == typeof(int?));
                Assert.Contains(
                    valMachine.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                    field => field.Name.Contains("<$ncap_", StringComparison.Ordinal)
                        && field.FieldType == typeof(string));
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static object[] Case(string name, string body, string expected) =>
        new object[] { name, body, expected };

    private static string Wrap(string body) =>
        """
        package issue2771
        import System
        import System.Threading.Tasks

        """ + body;

    private static string CompileVerifyAndRun(string source)
    {
        var (directory, outputPath) = Compile(source);
        try
        {
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
            });
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, error);
            return output.Replace("\r\n", "\n");
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static (string Directory, string OutputPath) Compile(string source)
    {
        var directory = Path.GetFullPath(Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "test-artifacts",
            "issue2771-" + Guid.NewGuid().ToString("N")));
        Directory.CreateDirectory(directory);
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
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(exitCode == 0, $"compile failed ({exitCode}):\n{stdout}\n{stderr}");
        return (directory, outputPath);
    }

    private static void DeleteDirectory(string directory)
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
