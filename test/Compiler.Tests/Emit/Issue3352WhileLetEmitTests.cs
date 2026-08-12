// <copyright file="Issue3352WhileLetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Emit/runtime coverage for issue #3352 / ADR-0163.</summary>
public sealed class Issue3352WhileLetEmitTests
{
    [Fact]
    public void ConditionReevaluatesAndContinueAndBreakUseLoopTargets()
    {
        var assembly = CompileAndInvokeEntry("""
            package P

            public var calls = 0
            public var trace = ""

            func Next() string? {
                calls = calls + 1
                if calls == 1 { return "skip" }
                if calls == 2 { return "keep" }
                if calls == 3 { return "stop" }
                return nil
            }

            while let value = Next() {
                if value == "skip" { continue }
                trace = trace + value
                if value == "stop" { break }
            }
            """);

        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        Assert.Equal(3, ReadStatic<int>(program, "calls"));
        Assert.Equal("keepstop", ReadStatic<string>(program, "trace"));
    }

    [Fact]
    public void NaturalTerminationPerformsFailingConditionEvaluation()
    {
        var assembly = CompileAndInvokeEntry("""
            package P

            public var calls = 0
            public var trace = ""

            func Next() string? {
                calls = calls + 1
                if calls <= 2 { return calls.ToString() }
                return nil
            }

            while let value = Next() {
                trace = trace + value
            }
            """);

        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        Assert.Equal(3, ReadStatic<int>(program, "calls"));
        Assert.Equal("12", ReadStatic<string>(program, "trace"));
    }

    [Fact]
    public void MultipleBindingsReevaluateBeforeEachCombinedTest()
    {
        var assembly = CompileAndInvokeEntry("""
            package P

            public var firstCalls = 0
            public var secondCalls = 0
            public var trace = ""

            func First() string? {
                firstCalls = firstCalls + 1
                if firstCalls == 1 { return "A" }
                return nil
            }

            func Second() string? {
                secondCalls = secondCalls + 1
                return "B"
            }

            while let left = First(), let right = Second() {
                trace = trace + left + right
            }
            """);

        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        Assert.Equal("AB", ReadStatic<string>(program, "trace"));
        Assert.Equal(2, ReadStatic<int>(program, "firstCalls"));
        Assert.Equal(2, ReadStatic<int>(program, "secondCalls"));
    }

    [Fact]
    public void NestedBindingsShadowAndRestoreOuterBinding()
    {
        var assembly = CompileAndInvokeEntry("""
            package P

            public var outerCalls = 0
            public var innerCalls = 0
            public var trace = ""

            func NextOuter() string? {
                outerCalls = outerCalls + 1
                if outerCalls == 1 { return "A" }
                return nil
            }

            func NextInner() string? {
                innerCalls = innerCalls + 1
                if innerCalls <= 2 { return innerCalls.ToString() }
                return nil
            }

            while let value = NextOuter() {
                trace = trace + value
                while let value = NextInner() {
                    trace = trace + value
                }
                trace = trace + value
            }
            """);

        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        Assert.Equal("A12A", ReadStatic<string>(program, "trace"));
        Assert.Equal(2, ReadStatic<int>(program, "outerCalls"));
        Assert.Equal(3, ReadStatic<int>(program, "innerCalls"));
    }

    [Fact]
    public void LabeledContinueAndBreakTargetOuterWhileLet()
    {
        var assembly = CompileAndInvokeEntry("""
            package P

            public var outerCalls = 0
            public var innerCalls = 0
            public var trace = ""

            func NextOuter() string? {
                outerCalls = outerCalls + 1
                if outerCalls == 1 { return "A" }
                if outerCalls == 2 { return "B" }
                return nil
            }

            func NextInner() string? {
                innerCalls = innerCalls + 1
                return "inner"
            }

            outer: while let outerValue = NextOuter() {
                trace = trace + outerValue
                while let innerValue = NextInner() {
                    if outerValue == "A" { continue outer }
                    break outer
                }
                trace = trace + "unreached"
            }
            """);

        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        Assert.Equal("AB", ReadStatic<string>(program, "trace"));
        Assert.Equal(2, ReadStatic<int>(program, "outerCalls"));
        Assert.Equal(2, ReadStatic<int>(program, "innerCalls"));
    }

    [Fact]
    public void AwaitedInitializerReevaluatesAcrossSuspensions()
    {
        var assembly = CompileAndInvokeEntry("""
            package P

            import System.Threading.Tasks

            public var calls = 0
            public var trace = ""

            func Next() string? {
                calls = calls + 1
                if calls <= 2 { return calls.ToString() }
                return nil
            }

            async func Run() string {
                var result = ""
                while let value = await Task.FromResult(Next()) {
                    result = result + value
                }
                return result
            }

            trace = Run().Result
            """);

        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        Assert.Equal(3, ReadStatic<int>(program, "calls"));
        Assert.Equal("12", ReadStatic<string>(program, "trace"));
    }

    private static T ReadStatic<T>(Type type, string name)
    {
        var field = type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(field);
        return (T)field!.GetValue(null)!;
    }

    private static Assembly CompileAndInvokeEntry(string source)
    {
        var workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue-3352-emit",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            var sourcePath = Path.Combine(workDir, "test.gs");
            var outputPath = Path.Combine(workDir, "test.dll");
            File.WriteAllText(sourcePath, source);

            var args = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                sourcePath,
            };

            var exitCode = Program.Main(args.ToArray());
            Assert.Equal(0, exitCode);
            IlVerifier.Verify(outputPath);

            var assembly = Assembly.Load(File.ReadAllBytes(outputPath));
            var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
            var entry = program.GetMethod(
                "<Main>$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(entry);
            entry!.Invoke(
                null,
                entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            return assembly;
        }
        finally
        {
            try
            {
                Directory.Delete(workDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
