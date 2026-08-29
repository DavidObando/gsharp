// <copyright file="Issue3646ThrowLambdaImportedGenericTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Regression tests for issue #3646: a throw-expression lambda passed to an
/// imported generic method taking a delegate parameter (e.g. Roslyn's
/// <c>IncrementalGeneratorInitializationContext.RegisterSourceOutput(provider,
/// action)</c>, or the BCL's <c>Array.ForEach(array, action)</c>) failed with
/// GS0159 "Cannot find function". The lambda's natural function type returns
/// the bottom (<c>never</c>) type, which has no CLR erasure, so the erased
/// delegate CLR shape used to gate imported-overload applicability could not
/// be built and every candidate was rejected before overload resolution ran.
/// The fix erases a <c>never</c> return like <c>void</c> (issue #2716 already
/// lets a never-returning literal convert to any delegate result slot).
/// </summary>
public class Issue3646ThrowLambdaImportedGenericTests
{
    [Fact]
    public void ThrowLambda_ToImportedGenericMethodActionParameter_Compiles()
    {
        // Array.ForEach<T>(T[], Action<T>) — T inferred from the array
        // argument, the throw-expression lambda flows into Action<T>.
        CompileGsAgainstTpa("""
            package Probe

            import System

            func main() {
                var xs = []int32{1, 2, 3}
                Array.ForEach(xs, (v int32) -> throw InvalidOperationException("boom"))
            }
            """);
    }

    [Fact]
    public void ThrowLambda_ToRoslynRegisterSourceOutput_Compiles()
    {
        // The exact shape from the migrated GeneratorHost tests: a generic
        // instance method on the imported STRUCT
        // IncrementalGeneratorInitializationContext, whose T flows from the
        // IncrementalValueProvider<Compilation> argument into the
        // Action<SourceProductionContext, T> delegate parameter, with a
        // throw-expression lambda as the action.
        CompileGsAgainstTpa(
            """
            package Probe

            import System
            import Microsoft.CodeAnalysis

            public class ThrowingGenerator : IIncrementalGenerator {
                public func Initialize(context IncrementalGeneratorInitializationContext) {
                    context.RegisterSourceOutput(
                        context.CompilationProvider,
                        (spc SourceProductionContext, _ Compilation) -> throw InvalidOperationException("boom"))
                }
            }
            """,
            requiredAssemblySimpleName: "Microsoft.CodeAnalysis");
    }

    /// <summary>
    /// Drives gsc in-process against the host's trusted-platform-assembly
    /// closure (which includes the test project's Microsoft.CodeAnalysis
    /// package assemblies), asserting a clean compile. Mirrors
    /// <see cref="XunitAssertOverloadResolutionTests"/>' compile helper.
    /// </summary>
    /// <param name="source">G# source to compile.</param>
    /// <param name="requiredAssemblySimpleName">
    /// Optional assembly simple name that must be present in the reference
    /// closure; when absent the test surfaces a missing-prerequisite failure
    /// instead of a misleading compile error.
    /// </param>
    private static void CompileGsAgainstTpa(string source, string requiredAssemblySimpleName = null)
    {
        var references = TrustedPlatformAssemblies().ToList();
        if (requiredAssemblySimpleName != null
            && !references.Any(p => string.Equals(
                Path.GetFileNameWithoutExtension(p),
                requiredAssemblySimpleName,
                StringComparison.OrdinalIgnoreCase)))
        {
            throw new Xunit.Sdk.XunitException(
                $"prerequisite missing: '{requiredAssemblySimpleName}' not present in the host TPA");
        }

        var tempDir = Directory.CreateTempSubdirectory("gs_issue3646_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Probe.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, "Probe.dll");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var reference in references)
            {
                args.Add("/reference:" + reference);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            Assert.True(File.Exists(outPath), "expected emitted assembly");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup only.
            }
        }
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
