// <copyright file="Issue3626NullableTupleNilComparisonTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3626: <c>if let</c> (and any other <c>T? == nil</c> / <c>!= nil</c>
/// comparison) over a <c>Nullable&lt;TupleTypeSymbol&gt;</c> whose tuple has a
/// symbolic (null) <c>ClrType</c> — e.g. an element carries a
/// nullable-reference-type annotation like <c>string?</c> — emitted an
/// unverifiable <c>ldfld; ldnull; ceq</c> instead of the lifted
/// <c>get_HasValue</c> check. The root cause was in
/// <c>LiftedBinaryOperatorCollector.IsLiftedValueTypeBinary</c>, which probed
/// <c>ClrType.IsValueType</c> directly instead of going through
/// <c>NullableLifting.IsValueTypeNullable</c> (which already special-cases
/// tuples for exactly this reason). The bug reproduced for sync AND async
/// methods, same-compilation AND imported tuples, and named AND unnamed
/// tuples — narrower than the original report, which observed it only in an
/// async/imported/named context.
/// </summary>
public sealed class Issue3626NullableTupleNilComparisonTests
{
    [Fact]
    public void IfLetOverNullableTupleWithNullableReferenceElement_SameCompilation_MatchAndNoMatch()
    {
        const string Source = """
            package Issue3626SameComp

            import System

            class S {
                shared {
                    func SyncNullable(ok bool) (A int32, B string?)? {
                        if ok { return (7, "x") }
                        return nil
                    }
                }
            }

            func Run(ok bool) {
                if let r = S.SyncNullable(ok) {
                    Console.WriteLine(r.A)
                    Console.WriteLine(r.B)
                } else {
                    Console.WriteLine("nil")
                }
            }

            Run(true)
            Run(false)
            """;

        Assert.Equal(
            $"7{Environment.NewLine}x{Environment.NewLine}nil{Environment.NewLine}",
            CompileVerifyAndRun(Source));
    }

    [Fact]
    public void AsyncNonAwaitedIfLetOverImportedNullableNamedTuple_VerifiesAndRuns()
    {
        const string ContractSource = """
            #nullable enable
            using System;

            namespace Issue3626.Contract;

            public static class S2
            {
                public static (int A, string? B)? SyncNullable(bool has)
                {
                    if (has)
                    {
                        return (1, "x");
                    }
                    return null;
                }
            }
            """;

        const string Source = """
            package Issue3626Async

            import System
            import Issue3626.Contract

            async func Run() {
                if let r = S2.SyncNullable(true) {
                    Console.WriteLine(r.A)
                    Console.WriteLine(r.B)
                }
            }

            Run().Wait()
            """;

        Assert.Equal(
            $"1{Environment.NewLine}x{Environment.NewLine}",
            CompileVerifyAndRun(Source, ContractSource));
    }

    [Fact]
    public void AsyncNonAwaitedIfLetOverImportedNullableUnnamedTuple_VerifiesAndRuns()
    {
        const string ContractSource = """
            #nullable enable
            using System;

            namespace Issue3626.Contract;

            public static class S2
            {
                public static (int, string?)? SyncNullable(bool has)
                {
                    if (has)
                    {
                        return (1, "x");
                    }
                    return null;
                }
            }
            """;

        const string Source = """
            package Issue3626AsyncUnnamed

            import System
            import Issue3626.Contract

            async func Run() {
                if let r = S2.SyncNullable(true) {
                    Console.WriteLine(r.Item1)
                    Console.WriteLine(r.Item2)
                }
            }

            Run().Wait()
            """;

        Assert.Equal(
            $"1{Environment.NewLine}x{Environment.NewLine}",
            CompileVerifyAndRun(Source, ContractSource));
    }

    private static string CompileVerifyAndRun(string source, string contractSource = null)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3626NullableTupleNilComparisonTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "Program.gs");
            var outputPath = Path.Combine(directory, "Issue3626.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            string contractPath = null;
            if (contractSource != null)
            {
                contractPath = CompileContract(directory, contractSource);
                arguments.Add("/reference:" + contractPath);
            }

            foreach (var reference in ReferenceResolver.HostTrustedPlatformAssemblyPaths())
            {
                arguments.Add("/reference:" + reference);
            }

            arguments.Add(sourcePath);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
            int exitCode;
            try
            {
                exitCode = Program.Main(arguments.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed:{Environment.NewLine}{standardOut}{standardError}");
            IlVerifier.Verify(outputPath, contractPath == null ? null : new[] { contractPath });

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
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}:{Environment.NewLine}{error}");
            return output.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileContract(string directory, string source)
    {
        var references = ReferenceResolver.HostTrustedPlatformAssemblyPaths()
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "GSharp.Issue3626.Contract",
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
        var path = Path.Combine(directory, "GSharp.Issue3626.Contract.dll");
        using var stream = File.Create(path);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }
}
