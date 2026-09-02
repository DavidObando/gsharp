// <copyright file="Issue3828EmittedFixtureIsolationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3828: an emitted test fixture must not become a reference for the
/// next in-process compilation.
/// </summary>
/// <remarks>
/// Emit tests run gsc in-process with no <c>/reference:</c> and then load the
/// produced PE. Loading it into the default context left it visible to
/// <c>ReferenceResolver.BuildHostAssemblies</c>, so a later fixture declaring
/// the same package bound the earlier fixture's types and the compile failed
/// inside gsc — <c>GS0156: Cannot convert type 'P.Color' to 'Color'</c> in
/// <c>compiler-emit-remainder</c>, whenever class order put the colliding
/// fixture first.
/// </remarks>
public class Issue3828EmittedFixtureIsolationTests
{
    private const string FirstFixture = """
        package P
        import System

        enum Color { Red, Green, Blue }

        func ToInt(c Color) int32 {
            return int32(c)
        }
        """;

    private const string SecondFixture = """
        package P
        import System

        enum Color { Red, Green, Blue }

        func FromInt(i int32) Color {
            return Color(i)
        }
        """;

    /// <summary>
    /// Forces the order that made the shard fail: compile and load a fixture
    /// declaring <c>P.Color</c>, then compile a second one declaring its own
    /// <c>P.Color</c>. Before the fix the second compile fails with GS0156,
    /// because it binds the first fixture's enum; both fixtures here also run,
    /// so the isolation is proved at execution and not only at bind time.
    /// </summary>
    [Fact]
    public void LoadedFixture_DoesNotShadow_TheNextCompilationOfTheSamePackage()
    {
        var first = CompileAndLoad(FirstFixture, "first");
        var firstColor = first.GetTypes().Single(t => t.Name == "Color");
        var toInt = first.GetTypes().Single(t => t.Name == "<Program>").GetMethod(
            "ToInt",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(toInt);
        Assert.Equal(2, toInt.Invoke(null, new[] { Enum.ToObject(firstColor, 2) }));

        // The compile that GS0156 used to fail.
        var second = CompileAndLoad(SecondFixture, "second");
        var secondColor = second.GetTypes().Single(t => t.Name == "Color");
        var fromInt = second.GetTypes().Single(t => t.Name == "<Program>").GetMethod(
            "FromInt",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(fromInt);

        var value = fromInt.Invoke(null, new object[] { 1 });
        Assert.NotNull(value);
        Assert.Equal(secondColor, value.GetType());
        Assert.Equal("Green", value.ToString());

        // Each fixture keeps its own enum identity; neither borrowed the other's.
        Assert.NotSame(firstColor, secondColor);
    }

    /// <summary>
    /// Pins the property <c>BuildHostAssemblies</c> keys on: a fixture loaded
    /// through the shared helper lives in a collectible context, which that
    /// scan skips. Unique assembly names would not give this — the leak, not
    /// the name, is what made a fixture ambient.
    /// </summary>
    [Fact]
    public void LoadedFixture_LivesInACollectibleContext_SoTheHostScanSkipsIt()
    {
        var assembly = CompileAndLoad(FirstFixture, "context");

        var context = AssemblyLoadContext.GetLoadContext(assembly);
        Assert.NotNull(context);
        Assert.True(context.IsCollectible, "Emitted fixtures must load into a collectible context.");
        Assert.NotSame(AssemblyLoadContext.Default, context);

        Assert.DoesNotContain(
            AppDomain.CurrentDomain.GetAssemblies(),
            loaded => ReferenceEquals(loaded, assembly)
                && !(AssemblyLoadContext.GetLoadContext(loaded)?.IsCollectible ?? false));
    }

    private static Assembly CompileAndLoad(string source, string assemblyName)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3828_").FullName;
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exitCode == 0,
            $"gsc failed for {assemblyName}:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        return EmittedFixture.Load(outputPath);
    }
}
