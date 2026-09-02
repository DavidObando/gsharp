// <copyright file="Issue2891TryRegionFlowEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2891: accepted try-region control-flow shapes must emit verifiable
/// assemblies, load successfully, and execute their finally behavior.
/// </summary>
public class Issue2891TryRegionFlowEmitTests
{
    /// <summary>Gets finite accepted try-region programs and their expected result.</summary>
    public static IEnumerable<object[]> FiniteCases()
    {
        yield return Case("TryContinue", 3, """
            func F() int32 {
                var count = 0
                for i in 0 ... 3 {
                    try {
                        continue
                    } finally {
                        count += 1
                    }
                }
                return count
            }
            public var result = F()
            """);
        yield return Case("LabeledTryContinue", 2, """
            func F() int32 {
                var count = 0
                outer: for i in 0 ... 2 {
                    for j in 0 ... 2 {
                        try {
                            continue outer
                        } finally {
                            count += 1
                        }
                    }
                }
                return count
            }
            public var result = F()
            """);
        yield return Case("CatchContinue", 3, """
            import System
            func F() int32 {
                var count = 0
                for i in 0 ... 3 {
                    try {
                        throw Exception("boom")
                    } catch (ex Exception) {
                        count += 1
                        continue
                    }
                }
                return count
            }
            public var result = F()
            """);
        yield return Case("FinallyContinue", 3, """
            func F() int32 {
                var count = 0
                for i in 0 ... 3 {
                    try {
                    } finally {
                        count += 1
                        continue
                    }
                }
                return count
            }
            public var result = F()
            """);
        yield return Case("LabeledCatchContinue", 2, """
            import System
            func F() int32 {
                var count = 0
                outer: for i in 0 ... 2 {
                    for j in 0 ... 2 {
                        try {
                            throw Exception("boom")
                        } catch (ex Exception) {
                            count += 1
                            continue outer
                        }
                    }
                }
                return count
            }
            public var result = F()
            """);
        yield return Case("LabeledFinallyContinue", 2, """
            func F() int32 {
                var count = 0
                outer: for i in 0 ... 2 {
                    for j in 0 ... 2 {
                        try {
                        } finally {
                            count += 1
                            continue outer
                        }
                    }
                }
                return count
            }
            public var result = F()
            """);
        yield return Case("TryFinallyReturn", 3, """
            public var finalCount = 0
            func F() int32 {
                try {
                    return 2
                } finally {
                    finalCount += 1
                }
            }
            public var result = F() + finalCount
            """);
        yield return Case("FinallyReturn", 2, """
            func F() int32 {
                try {
                    return 1
                } finally {
                    return 2
                }
            }
            public var result = F()
            """);
        yield return Case("ConditionalFinallyReturnOverException", 9, """
            import System
            func F(replace bool) int32 {
                try {
                    throw Exception("origin")
                } finally {
                    if replace {
                        return 2
                    }
                }
            }
            public var result = F(true)
            try {
                F(false)
            } catch (ex Exception) {
                result += ex.Message == "origin" ? 7 : -100
            }
            """);
        yield return Case("ConditionalFinallyReturnOverReturn", 3, """
            func F(replace bool) int32 {
                try {
                    return 1
                } finally {
                    if replace {
                        return 2
                    }
                }
            }
            public var result = F(false) + F(true)
            """);
        yield return Case("ConditionalFinallyReturnOverBreak", 2, """
            func F(replace bool) int32 {
                var count = 0
                for i in 0 ... 3 {
                    try {
                        break
                    } finally {
                        if replace {
                            return 2
                        }
                    }
                    count += 1
                }
                return count
            }
            public var result = F(false) + F(true)
            """);
        yield return Case("RethrowPreservesOriginStack", 7, """
            import System
            func Origin() {
                throw Exception("origin")
            }
            func F(replace bool) int32 {
                try {
                    Origin()
                    return 0
                } finally {
                    if replace {
                        return 2
                    }
                }
            }
            public var result = F(true)
            try {
                F(false)
            } catch (ex Exception) {
                result += ex.StackTrace.Contains("<Program>.Origin") ? 5 : -100
            }
            """);
        yield return Case("ExceptionSuppressedByFinallyBreak", 4, """
            import System
            func F() int32 {
                for {
                    try {
                        throw Exception("origin")
                    } finally {
                        break
                    }
                }
                return 4
            }
            public var result = F()
            """);
        yield return Case("ExceptionSuppressedByFinallyContinue", 3, """
            import System
            func F() int32 {
                var count = 0
                for i in 0 ... 3 {
                    try {
                        throw Exception("origin")
                    } finally {
                        count += 1
                        continue
                    }
                }
                return count
            }
            public var result = F()
            """);
        yield return Case("ExceptionSuppressedByFinallyGoto", 5, """
            import System
            func F() int32 {
                try {
                    throw Exception("origin")
                } finally {
                    goto done
                }
            done:
                return 5
            }
            public var result = F()
            """);
        yield return Case("TryCatchReturns", 3, """
            import System
            func F(flag bool) int32 {
                try {
                    if flag {
                        return 1
                    }
                    throw Exception("boom")
                } catch (ex Exception) {
                    return 2
                }
            }
            public var result = F(true) + F(false)
            """);
        yield return Case("TryCatchFinallyReturns", 5, """
            import System
            public var finalCount = 0
            func F(flag bool) int32 {
                try {
                    if flag {
                        return 1
                    }
                    throw Exception("boom")
                } catch (ex Exception) {
                    return 2
                } finally {
                    finalCount += 1
                }
            }
            public var result = F(true) + F(false) + finalCount
            """);
        yield return Case("ConditionalFinallyReturnOverCatchReturn", 3, """
            import System
            func F(replace bool) int32 {
                try {
                    throw Exception("origin")
                } catch (ex Exception) {
                    return 1
                } finally {
                    if replace {
                        return 2
                    }
                }
            }
            public var result = F(false) + F(true)
            """);
        yield return Case("CatchRethrows", 7, """
            import System
            func F() int32 {
                try {
                    throw Exception("first")
                } catch (ex Exception) {
                    throw Exception("second")
                }
            }
            public var result = 0
            try {
                F()
            } catch (ex Exception) {
                result = ex.Message == "second" ? 7 : -1
            }
            """);
        yield return Case("FinallyThrows", 9, """
            import System
            func F() int32 {
                try {
                    var value = 1
                } finally {
                    throw Exception("stop")
                }
            }
            public var result = 0
            try {
                F()
            } catch (ex Exception) {
                result = ex.Message == "stop" ? 9 : -1
            }
            """);
        yield return Case("ReturnAfterTryBreak", 7, """
            func F() int32 {
                for {
                    try {
                        break
                    } finally {
                    }
                }
                return 7
            }
            public var result = F()
            """);
        yield return Case("ReturnAfterCatchBreak", 8, """
            import System
            func F() int32 {
                for {
                    try {
                        throw Exception("boom")
                    } catch (ex Exception) {
                        break
                    }
                }
                return 8
            }
            public var result = F()
            """);
        yield return Case("TryGotoThenReturn", 3, """
            public var finalCount = 0
            func F() int32 {
                try {
                    goto done
                } finally {
                    finalCount += 1
                }
                return 1
            done:
                return 2
            }
            public var result = F() + finalCount
            """);
        yield return Case("CatchGotoThenReturn", 2, """
            import System
            func F() int32 {
                try {
                    throw Exception("boom")
                } catch (ex Exception) {
                    goto done
                }
                return 1
            done:
                return 2
            }
            public var result = F()
            """);
        yield return Case("FinallyGotoThenReturn", 2, """
            func F() int32 {
                try {
                    return 1
                } finally {
                    goto done
                }
            done:
                return 2
            }
            public var result = F()
            """);
        yield return Case("TryInsideFinallyReturns", 1, """
            func F() int32 {
                try {
                    return 1
                } finally {
                    try {
                        var value = 2
                    } finally {
                    }
                }
            }
            public var result = F()
            """);
        yield return Case("NestedFinallyBreakThenReturn", 6, """
            func F() int32 {
                for {
                    try {
                        return 1
                    } finally {
                        try {
                            break
                        } finally {
                        }
                    }
                }
                return 6
            }
            public var result = F()
            """);
        yield return Case("SwitchInsideTryBreakOverriddenByReturn", 1, """
            func F() int32 {
                for {
                    try {
                        switch 0 {
                            default { break }
                        }
                    } finally {
                        return 1
                    }
                }
            }
            public var result = F()
            """);
        yield return Case("SelectInsideTryBreakOverriddenByReturn", 2, """
            import Gsharp.Extensions.Go
            func F() int32 {
                for {
                    try {
                        select {
                            default { break }
                        }
                    } finally {
                        return 2
                    }
                }
            }
            public var result = F()
            """);
        yield return Case("ScopeInsideTryBreakOverriddenByReturn", 4, """
            import Gsharp.Extensions.Go
            func F() int32 {
                for {
                    try {
                        scope {
                            break
                        }
                    } finally {
                        return 4
                    }
                }
            }
            public var result = F()
            """);
    }

    /// <summary>Gets nested branch-analysis shapes that require runtime execution guards.</summary>
    public static IEnumerable<object[]> BranchAnalysisExecutionCases()
    {
        yield return OutputCase("LocalGotoInTry", "fin#1\nr=1301\n", """
            import System
            func F() int32 {
                var result = 100
                for {
                    try {
                    again:
                        result += 1
                        if result < 103 {
                            goto again
                        }
                        result += 1198
                    } finally {
                        Console.WriteLine("fin#1")
                        break
                    }
                }
                return result
            }
            Console.WriteLine("r=" + F().ToString())
            """);
        yield return OutputCase("LocalGotoInNestedFinally", "outerfin\nr=5\n", """
            import System
            func F() int32 {
                var result = 0
                for {
                    try {
                        try {
                        } finally {
                            goto local
                        local:
                            result = 5
                        }
                    } finally {
                        Console.WriteLine("outerfin")
                        break
                    }
                }
                return result
            }
            Console.WriteLine("r=" + F().ToString())
            """);
        yield return OutputCase("LocalGotoInNestedCatch", "outerfin\nr=3\n", """
            import System
            func F() int32 {
                var result = 0
                for {
                    try {
                        try {
                            throw Exception("enter catch")
                        } catch (ex Exception) {
                            goto local
                        local:
                            result = 3
                        }
                    } finally {
                        Console.WriteLine("outerfin")
                        break
                    }
                }
                return result
            }
            Console.WriteLine("r=" + F().ToString())
            """);
    }

    [Theory]
    [MemberData(nameof(FiniteCases))]
    public void AcceptedFiniteShape_VerifiesLoadsAndRuns(string name, int expected, string source)
    {
        var assembly = CompileVerifyLoadAndRun(name, source);
        Assert.Equal(expected, GetField(assembly, "result"));
    }

    [Theory]
    [MemberData(nameof(BranchAnalysisExecutionCases))]
    public void NestedBranchAnalysis_LoadsAndRunsInChild(string name, string expectedOutput, string source)
        => CompileLoadAndRunChild(name, source, expectedOutput);

    [Theory]
    [InlineData("FinallyInfiniteLoop", false)]
    [InlineData("BreakSuppressedByInfiniteFinally", true)]
    public void InfiniteFinally_VerifiesLoadsStartsAndIsBounded(string name, bool startsWithBreak)
    {
        var body = startsWithBreak
            ? """
                for {
                    try {
                        break
                    } finally {
                        Console.WriteLine("entered")
                        for {
                        }
                    }
                }
                """
            : """
                try {
                    var value = 1
                } finally {
                    Console.WriteLine("entered")
                    for {
                    }
                }
                """;
        var source = $$"""
            package Issue2891.Emit{{name}}
            import System
            func F() int32 {
            {{body}}
            }
            F()
            """;

        CompileLoadAndRunChild(name, source);
    }

    private static object[] Case(string name, int expected, string body)
        => new object[] { name, expected, $"package Issue2891.Emit{name}{Environment.NewLine}{body}" };

    private static object[] OutputCase(string name, string expectedOutput, string body)
        => new object[] { name, expectedOutput, $"package Issue2891.Emit{name}{Environment.NewLine}{body}" };

    private static Assembly CompileVerifyLoadAndRun(string name, string source)
    {
        using var peStream = new MemoryStream();
        EmitResult result;
        try
        {
            result = new Compilation(SyntaxTree.Parse(SourceText.From(source))).Emit(peStream);
        }
        catch (Exception exception)
        {
            throw new Xunit.Sdk.XunitException(exception.ToString());
        }

        Assert.True(
            result.Success,
            string.Join(
                Environment.NewLine,
                result.Diagnostics.Select(diagnostic => $"{diagnostic.Id}: {diagnostic.Message}")));

        var bytes = peStream.ToArray();
        var assemblyPath = Path.Combine(Directory.GetCurrentDirectory(), $"Issue2891_{name}_{Guid.NewGuid():N}.dll");
        try
        {
            File.WriteAllBytes(assemblyPath, bytes);
            IlVerifier.Verify(assemblyPath);
        }
        finally
        {
            File.Delete(assemblyPath);
        }

        var assembly = EmittedFixture.Load(bytes);
        var types = assembly.GetTypes();
        Assert.NotEmpty(types);
        var program = types.Single(type => type.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
        var execution = Task.Run(
            () => entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() }));
        Assert.True(execution.Wait(TimeSpan.FromSeconds(10)), $"{name} execution timed out");
        return assembly;
    }

    private static void CompileLoadAndRunChild(
        string name,
        string source,
        string expectedOutput = null)
    {
        var prefix = $"Issue2891_{name}_{Guid.NewGuid():N}";
        var directory = Directory.GetCurrentDirectory();
        var sourcePath = Path.Combine(directory, prefix + ".gs");
        var assemblyPath = Path.Combine(directory, prefix + ".dll");
        try
        {
            File.WriteAllText(sourcePath, source);
            var exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.Equal(0, exitCode);
            IlVerifier.Verify(assemblyPath);
            Assert.NotEmpty(EmittedFixture.Load(assemblyPath).GetTypes());

            var start = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            start.ArgumentList.Add("exec");
            start.ArgumentList.Add("--runtimeconfig");
            start.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
            start.ArgumentList.Add(assemblyPath);

            using var process = Process.Start(start)!;
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            var exited = process.WaitForExit(expectedOutput == null ? 3_000 : 10_000);
            if (!exited)
            {
                process.Kill(entireProcessTree: true);
                Assert.True(process.WaitForExit(5_000), $"{name} child did not stop after kill");
            }

            var stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine);
            var stderr = stderrTask.GetAwaiter().GetResult();
            if (expectedOutput == null)
            {
                Assert.False(exited, $"{name} unexpectedly completed\nstdout:\n{stdout}\nstderr:\n{stderr}");
                Assert.Contains("entered", stdout, StringComparison.Ordinal);
            }
            else
            {
                Assert.True(exited, $"{name} execution timed out");
                Assert.Equal(0, process.ExitCode);
                Assert.Equal(string.Empty, stderr);
                Assert.Equal(expectedOutput, stdout);
            }
        }
        finally
        {
            foreach (var path in Directory.EnumerateFiles(directory, prefix + "*"))
            {
                File.Delete(path);
            }
        }
    }

    private static int GetField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        return (int)program.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    }
}
