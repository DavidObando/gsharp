// <copyright file="Issue2885NullableDelegateReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2885 — direct invocation must not accept a nullable CLR-delegate
/// receiver when no valid smart-cast narrowing is in force.
/// </summary>
public class Issue2885NullableDelegateReceiverTests
{
    [Theory]
    [InlineData("mutable-field", "Src", "Mutable")]
    [InlineData("custom-property", "Src", "Custom")]
    [InlineData("shared-var", "Src", "SharedVar")]
    [InlineData("shared-let", "Src", "SharedLet")]
    [InlineData("invalidated-local", "Src", "n")]
    [InlineData("mutable-field", "int32", "Mutable")]
    [InlineData("custom-property", "int32", "Custom")]
    [InlineData("shared-var", "int32", "SharedVar")]
    [InlineData("shared-let", "int32", "SharedLet")]
    [InlineData("invalidated-local", "int32", "n")]
    public void DirectInvocation_WithoutValidNarrowing_ReportsNullableReceiver(
        string receiverShape,
        string typeArgument,
        string receiverName)
    {
        var source = BuildRejectedSource(receiverShape, typeArgument);
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var errors = compilation.BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();

        var diagnostic = Assert.Single(errors);
        Assert.Equal("GS0503", diagnostic.Id);
        Assert.Equal(receiverName, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.Contains($"'{receiverName}'", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains($"{receiverName}?(...)", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains("stable non-null local", diagnostic.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Src", "Src()", "2\n2\n2\n2\n2\n2\n2\n")]
    [InlineData("int32", "3", "3\n3\n3\n3\n3\n3\n3\n")]
    public void EndToEnd_StableAndNullSafeControls_VerifyLoadAndRun(
        string typeArgument,
        string valueExpression,
        string expectedOutput)
    {
        var sourceType = typeArgument == "Src"
            ? "class Src { prop N int32 -> 2 }\n"
            : string.Empty;
        var valueRead = typeArgument == "Src" ? "value.N" : "value";
        var source = $$"""
            package Issue2885Controls
            import System

            {{sourceType}}
            class Holder {
                let Field System.Action[{{typeArgument}}]?
                prop Property System.Action[{{typeArgument}}]? { get; init; }

                init(value System.Action[{{typeArgument}}]?) {
                    Field = value
                    Property = value
                }

                func Run(value {{typeArgument}}) {
                    if Field != nil {
                        Field(value)
                    }
                    if Property != nil {
                        Property(value)
                    }
                }
            }

            func Main() {
                let write System.Action[{{typeArgument}}] =
                    (value {{typeArgument}}) -> System.Console.WriteLine({{valueRead}})

                let direct System.Action[{{typeArgument}}] = write
                direct({{valueExpression}})

                var nonNull System.Action[{{typeArgument}}] = write
                nonNull({{valueExpression}})

                var optional System.Action[{{typeArgument}}]? = write
                if optional != nil {
                    optional({{valueExpression}})
                }
                if optional != nil {
                    let captured System.Action[{{typeArgument}}] = optional
                    captured({{valueExpression}})
                }

                Holder(write).Run({{valueExpression}})

                var safe System.Action[{{typeArgument}}]? = write
                safe?({{valueExpression}})
                var safeNil System.Action[{{typeArgument}}]? = nil
                safeNil?({{valueExpression}})
            }
            """;

        Assert.Equal(expectedOutput, CompileAndRun(source, typeArgument));
    }

    private static string BuildRejectedSource(string receiverShape, string typeArgument)
    {
        var sourceType = typeArgument == "Src"
            ? "class Src { prop N int32 -> 2 }\n"
            : string.Empty;
        var body = receiverShape switch
        {
            "mutable-field" => $$"""
                class Holder {
                    var Mutable System.Action[{{typeArgument}}]?

                    func Run(value {{typeArgument}}) {
                        if Mutable != nil {
                            Mutable(value)
                        }
                    }
                }
                """,
            "custom-property" => $$"""
                class Holder {
                    var Backing System.Action[{{typeArgument}}]?
                    prop Custom System.Action[{{typeArgument}}]? -> Backing

                    func Run(value {{typeArgument}}) {
                        if Custom != nil {
                            Custom(value)
                        }
                    }
                }
                """,
            "shared-var" => $$"""
                class Holder {
                    shared {
                        var SharedVar System.Action[{{typeArgument}}]?
                    }

                    func Run(value {{typeArgument}}) {
                        if SharedVar != nil {
                            SharedVar(value)
                        }
                    }
                }
                """,
            "shared-let" => $$"""
                class Holder {
                    shared {
                        let SharedLet System.Action[{{typeArgument}}]? = nil
                    }

                    func Run(value {{typeArgument}}) {
                        if SharedLet != nil {
                            SharedLet(value)
                        }
                    }
                }
                """,
            "invalidated-local" => $$"""
                func Run(write System.Action[{{typeArgument}}], value {{typeArgument}}) {
                    var n System.Action[{{typeArgument}}]? = write
                    if n != nil {
                        n = nil
                        n(value)
                    }
                }
                """,
            _ => throw new ArgumentOutOfRangeException(nameof(receiverShape), receiverShape, null),
        };

        return $$"""
            package Issue2885Rejected
            import System

            {{sourceType}}
            {{body}}
            """;
    }

    private static string CompileAndRun(string source, string caseName)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2885-artifacts",
            caseName + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                var exitCode = Program.Main(new[]
                {
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
                Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            IlVerifier.Verify(assemblyPath);

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                    assemblyPath,
                },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            Assert.NotNull(process);
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, error);
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
