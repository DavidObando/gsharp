// <copyright file="Issue2715ForRangeNestedCaptureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2715: a for-range variable captured by a nested lambda inside an
/// outer lambda was boxed without allocating the box in the outer closure.
/// </summary>
public class Issue2715ForRangeNestedCaptureEmitTests
{
    [Fact]
    public void OahuPlainOutputWriter_OuterSafeWriteForRowNestedSelect_RunsAndVerifies()
    {
        const string Source = """
            package Oahu.Cli.Output
            import System
            import System.Collections.Generic
            import System.IO
            import System.Linq

            class OutputColumn(key string, header string) {
                prop Key string -> key
                prop Header string -> header
            }

            class PlainOutputWriter {
                private let writer TextWriter

                init(writer TextWriter) {
                    this.writer = writer
                }

                func WriteCollection(resourceName string, rows IReadOnlyList[IReadOnlyDictionary[string, object?]], columns IReadOnlyList[OutputColumn]) {
                    PlainOutputWriter.SafeWrite(() -> {
                        writer.WriteLine(String.Join('\t', columns.Select((c OutputColumn) -> c.Header)))
                        for row in rows {
                            writer.WriteLine(String.Join('\t', columns.Select((c OutputColumn) -> PlainOutputWriter.Format(if row!!.TryGetValue(c.Key, out var v) { v } else { default(object?) }))))
                        }
                    })
                }

                shared {
                    private func SafeWrite(action () -> void) {
                        try {
                            action()
                        } catch (ex IOException) {
                        } catch (ex ObjectDisposedException) {
                        }
                    }

                    private func Format(value object?) string {
                        return value?.ToString() ?? String.Empty
                    }
                }
            }

            var first = Dictionary[string, object?]()
            first.Add("left", "a")
            first.Add("right", "b")
            var second = Dictionary[string, object?]()
            second.Add("left", "c")
            second.Add("right", "d")
            var rows = List[IReadOnlyDictionary[string, object?]]{ first, second }
            var columns = List[OutputColumn]{ OutputColumn("right", "R"), OutputColumn("left", "L") }
            let output = StringWriter()
            PlainOutputWriter(output).WriteCollection("items", rows, columns)
            Console.Write(output.ToString())
            """;

        Assert.Equal("R\tL\nb\ta\nd\tc\n", CompileVerifyAndRun(Source, "Oahu"));
    }

    [Fact]
    public void ForRange_EscapingClosures_GetFreshBoxPerIteration()
    {
        const string Source = """
            package ForRangeCapture
            import System
            import System.Collections.Generic

            func SafeWrite(action () -> void) {
                action()
            }

            var values = List[int32]{ 1, 2, 3 }
            var readers = List[(() -> int32)]()
            SafeWrite(() -> {
                for value in values {
                    readers.Add(() -> value)
                }
            })
            Console.WriteLine(readers[0]())
            Console.WriteLine(readers[1]())
            Console.WriteLine(readers[2]())
            """;

        Assert.Equal("1\n2\n3\n", CompileVerifyAndRun(Source, "Escaping"));
    }

    [Fact]
    public void ForRange_KeyAndValueCapturedByNestedClosure_RunsAndVerifies()
    {
        const string Source = """
            package ForRangeKeyValueCapture
            import System
            import System.Collections.Generic

            var values = List[string]{ "a", "b" }
            var readers = List[(() -> string)]()
            let outer = () -> {
                for index, value in values {
                    readers.Add(() -> index.ToString() + value)
                }
            }
            outer()
            Console.WriteLine(readers[0]())
            Console.WriteLine(readers[1]())
            """;

        Assert.Equal("0a\n1b\n", CompileVerifyAndRun(Source, "KeyValue"));
    }

    [Fact]
    public void ForRange_VariableOutsideLoop_RemainsRejected()
    {
        var syntax = SyntaxTree.Parse(SourceText.From(
            """
            package ForRangeCaptureNegative
            import System.Collections.Generic

            func Run() {
                for value in List[int32]{ 1 } {}
                let invalid = () -> value
            }
            """));
        var compilation = new Compilation(syntax);

        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2715.Negative");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0125");
    }

    private static string CompileVerifyAndRun(string source, string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2715Emit", caseName);
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
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.True(exitCode == 0, $"compile failed ({exitCode}):\n{stdout}\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

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
}
