// <copyright file="Issue3626NullableTupleNilComparisonTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #3626: `if let` (and any other `T? == nil` / `!= nil`
/// comparison) over a `Nullable<TupleTypeSymbol>` whose tuple has a
/// symbolic (null) `ClrType` — e.g. an element carries a
/// nullable-reference-type annotation like `string?` — emitted an
/// unverifiable `ldfld; ldnull; ceq` instead of the lifted
/// `get_HasValue` check. The root cause was in
/// `LiftedBinaryOperatorCollector.IsLiftedValueTypeBinary`, which probed
/// `ClrType.IsValueType` directly instead of going through
/// `NullableLifting.IsValueTypeNullable` (which already special-cases
/// tuples for exactly this reason). The bug reproduced for sync AND async
/// methods, same-compilation AND imported tuples, and named AND unnamed
/// tuples — narrower than the original report, which observed it only in an
/// async/imported/named context.
class Issue3626NullableTupleNilComparisonTests {
    @Fact
    func IfLetOverNullableTupleWithNullableReferenceElement_SameCompilation_MatchAndNoMatch() {
        const Source = `package Issue3626SameComp

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
Run(false)`
        Assert.Equal(
            "7${Environment.NewLine}x${Environment.NewLine}nil${Environment.NewLine}",
            CompileVerifyAndRun(Source)
        )
    }

    @Fact
    func AsyncNonAwaitedIfLetOverImportedNullableNamedTuple_VerifiesAndRuns() {
        const ContractSource = `#nullable enable
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
}`
        const Source = `package Issue3626Async

import System
import Issue3626.Contract

async func Run() {
    if let r = S2.SyncNullable(true) {
        Console.WriteLine(r.A)
        Console.WriteLine(r.B)
    }
}

Run().Wait()`
        Assert.Equal("1${Environment.NewLine}x${Environment.NewLine}", CompileVerifyAndRun(Source, ContractSource))
    }

    @Fact
    func AsyncNonAwaitedIfLetOverImportedNullableUnnamedTuple_VerifiesAndRuns() {
        const ContractSource = `#nullable enable
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
}`
        const Source = `package Issue3626AsyncUnnamed

import System
import Issue3626.Contract

async func Run() {
    if let r = S2.SyncNullable(true) {
        Console.WriteLine(r.Item1)
        Console.WriteLine(r.Item2)
    }
}

Run().Wait()`
        Assert.Equal("1${Environment.NewLine}x${Environment.NewLine}", CompileVerifyAndRun(Source, ContractSource))
    }

    shared {
        private func CompileVerifyAndRun(source string, contractSource string? = nil) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3626NullableTupleNilComparisonTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Issue3626.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                var contractPath string? = nil
                if contractSource != nil {
                    contractPath = CompileContract(directory, contractSource)
                    arguments.Add("/reference:" + contractPath)
                }
                for reference in ReferenceResolver.HostTrustedPlatformAssemblyPaths() {
                    arguments.Add("/reference:" + reference)
                }
                arguments.Add(sourcePath)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(arguments.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "gsc failed:${Environment.NewLine}$standardOut$standardError")
                IlVerifier.Verify(
                    outputPath,
                    if contractPath == nil {
                        default([]?string)
                    } else {
                        []string{contractPath}
                    }
                )
                using let process Process? = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                            outputPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )
                let output = process!!.StandardOutput.ReadToEnd()
                let error = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, "exited ${process!!.ExitCode}:${Environment.NewLine}$error")
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileContract(directory string, source string) string {
            let references = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            )
            let compilation = CSharpCompilation.Create(
                "GSharp.Issue3626.Contract",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let path = Path.Combine(directory, "GSharp.Issue3626.Contract.dll")
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }
    }
}
