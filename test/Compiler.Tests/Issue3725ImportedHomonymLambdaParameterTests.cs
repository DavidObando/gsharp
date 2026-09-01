// <copyright file="Issue3725ImportedHomonymLambdaParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3725 (#3724 family B): the gsc half of the contract cs2gs must
/// satisfy. A bare imported type name is resolved by
/// <c>BoundScope.TryLookupImportedClassByArity</c> with FIRST-IMPORT-WINS, so
/// when two imported packages export the same simple name the bare spelling
/// picks one — and if the picked one is wrong, the failure surfaces at the
/// enclosing generic call as <c>GS0159 Cannot find function Where</c> rather
/// than at the name. Issue #3734 added the missing report at the name itself
/// (GS0547), so a bare homonym now also fails on its own line.
/// <para>
/// These tests pin both halves against a real two-package reference assembly
/// emitted by gsc itself: the bare spelling still fails exactly as the
/// migrated <c>DocumentSyncHandlerTests.gs</c> did, and the package-qualified
/// spelling cs2gs now emits binds the INTENDED type — asserted by RUNNING the
/// program, not merely by compiling it, because a lambda that bound the wrong
/// homonym and still compiled would be worse than the compile error.
/// </para>
/// </summary>
public class Issue3725ImportedHomonymLambdaParameterTests
{
    // `Probe.Alpha` sorts before `Probe.Beta`, so a bare `Item` resolves to
    // the Alpha type — the wrong one for a Beta-typed collection.
    private const string AlphaLibrary = """
        package Probe.Alpha

        class Item {
            var Label string = "alpha"
        }
        """;

    private const string BetaLibrary = """
        package Probe.Beta

        import System.Collections.Generic

        class Item {
            var Label string

            init(label string) {
                Label = label
            }
        }

        class Holder {
            shared {
                func Make() IReadOnlyList[Item] {
                    let items = List[Item]()
                    items.Add(Item("beta"))
                    items.Add(Item("other"))
                    return items
                }
            }
        }
        """;

    [Fact]
    public void BareHomonymLambdaParameter_FailsTheEnclosingGenericCall()
    {
        // The pre-#3725 emitted shape. `Item` binds to `Probe.Alpha.Item`, the
        // `Func[Alpha.Item, bool]` argument cannot unify with the
        // `IReadOnlyList[Beta.Item]` receiver, and inference fails at `Where`.
        (int exitCode, string output) = Compile("""
            package Probe.App

            import System
            import System.Linq
            import Probe.Alpha
            import Probe.Beta

            let items = Holder.Make()
            let hits = items.Where((d Item) -> d.Label == "beta").ToList()
            Console.WriteLine(hits.Count)
            """);

        Assert.True(exitCode != 0, "expected gsc to reject the bare homonym spelling:\n" + output);
        Assert.Contains("GS0159", output, StringComparison.Ordinal);
        Assert.Contains("Where", output, StringComparison.Ordinal);

        // Issue #3734: the collision is now also reported AT the name, three
        // steps closer to the mistake than the GS0159 above.
        Assert.Contains("GS0547", output, StringComparison.Ordinal);
    }

    [Fact]
    public void QualifiedHomonymLambdaParameter_BindsAndFiltersTheIntendedType()
    {
        // The shape cs2gs now emits. Compiling is not enough: the run pins that
        // the qualified name selected `Probe.Beta.Item` at RUNTIME — the
        // predicate reads `Beta.Item.Label`, whose values only that type has.
        string stdout = CompileAndRun("""
            package Probe.App

            import System
            import System.Linq
            import Probe.Alpha
            import Probe.Beta
            import AlphaItem = Probe.Alpha.Item

            let items = Holder.Make()
            let hits = items.Where((d Probe.Beta.Item) -> d.Label == "beta").ToList()
            Console.WriteLine(hits.Count)
            Console.WriteLine(hits[0].Label)
            Console.WriteLine(AlphaItem().Label)
            """);

        // One of the two Beta items matches, and its label round-trips — while
        // the Alpha construction proves the two homonyms really are both in
        // scope. Issue #3734 made the BARE `Item()` spelling this line used to
        // carry an error (GS0547); an alias import pins it instead, since a
        // package-qualified CONSTRUCTION of an imported CLR type is not a
        // spelling gsc accepts today.
        Assert.Equal(
            string.Join(Environment.NewLine, "1", "beta", "alpha") + Environment.NewLine,
            stdout);
    }

    private static (int ExitCode, string Output) Compile(string appSource)
    {
        (int exitCode, string output) = Build(appSource, out string workDir, out _);
        TryDelete(workDir);
        return (exitCode, output);
    }

    private static string CompileAndRun(string appSource)
    {
        (int exitCode, string output) = Build(appSource, out string workDir, out string appPath);
        try
        {
            Assert.True(exitCode == 0, "gsc failed:\n" + output);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(appPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(appPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("failed to start dotnet exec");
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(60_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static (int ExitCode, string Output) Build(string appSource, out string workDir, out string appPath)
    {
        // Two SEPARATE assemblies, matching the shape the migration hits: the
        // homonyms come from different referenced projects (GSharp.Core and
        // GSharp.LanguageServer), never from the app's own compilation.
        workDir = Directory.CreateTempSubdirectory("gs_issue3725_").FullName;
        string alphaLibPath = Path.Combine(workDir, "Probe.Alpha.dll");
        string betaLibPath = Path.Combine(workDir, "Probe.Beta.dll");
        appPath = Path.Combine(workDir, "Probe.App.dll");

        string alphaPath = Path.Combine(workDir, "Alpha.gs");
        string betaPath = Path.Combine(workDir, "Beta.gs");
        string appSourcePath = Path.Combine(workDir, "App.gs");
        File.WriteAllText(alphaPath, AlphaLibrary);
        File.WriteAllText(betaPath, BetaLibrary);
        File.WriteAllText(appSourcePath, appSource);

        (int alphaExit, string alphaOutput) = RunGsc(
            "/out:" + alphaLibPath,
            "/target:library",
            references: Array.Empty<string>(),
            sources: new[] { alphaPath });
        Assert.True(alphaExit == 0, "Probe.Alpha failed to compile:\n" + alphaOutput);

        (int betaExit, string betaOutput) = RunGsc(
            "/out:" + betaLibPath,
            "/target:library",
            references: Array.Empty<string>(),
            sources: new[] { betaPath });
        Assert.True(betaExit == 0, "Probe.Beta failed to compile:\n" + betaOutput);

        return RunGsc(
            "/out:" + appPath,
            "/target:exe",
            references: new[] { alphaLibPath, betaLibPath },
            sources: new[] { appSourcePath });
    }

    private static (int ExitCode, string Output) RunGsc(
        string outSwitch,
        string targetSwitch,
        IReadOnlyList<string> references,
        IReadOnlyList<string> sources)
    {
        var args = new List<string>
        {
            outSwitch,
            targetSwitch,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };

        foreach (string reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        foreach (string reference in references)
        {
            args.Add("/reference:" + reference);
        }

        args.AddRange(sources);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        TextWriter previousOut = Console.Out;
        TextWriter previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args.ToArray()), stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
        => ReferenceClosure.TrustedPlatformAssemblies();

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
