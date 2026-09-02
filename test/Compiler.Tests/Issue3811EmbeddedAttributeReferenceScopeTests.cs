// <copyright file="Issue3811EmbeddedAttributeReferenceScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3811: <c>NullableAttribute</c>/<c>NullableContextAttribute</c> rows
/// must never be scoped to a third-party assembly that merely happens to carry
/// its own embedded copy.
/// <para>
/// These two attributes are <em>compiler-embeddable</em>: csc synthesizes a
/// private copy into the emitting assembly whenever the target framework does
/// not publish them, which is why practically every <c>netstandard2.0</c>
/// package assembly contains an <c>internal</c>
/// <c>System.Runtime.CompilerServices.NullableAttribute</c> of its own. gsc
/// resolved the name across its whole reference closure with
/// <c>requireExternalVisibility: false</c> and scoped its TypeRef at whichever
/// package declared it first — for <c>src/Sdk/Gsharp.NET.Sdk</c> that was
/// <c>Microsoft.Build.Framework</c>. The emitted assembly then referenced a
/// type that is neither public nor present in that package's other assets, and
/// the NEXT gsc compilation that read the assembly's nullability metadata threw
/// <c>TypeLoadException: Could not find type
/// 'System.Runtime.CompilerServices.NullableAttribute' in assembly ''</c>,
/// reported as the internal-compiler-error diagnostic <c>GS9998</c>.
/// </para>
/// <para>
/// That crash is the single error walling <c>test/Sdk.Tests</c> out of the
/// issue #3501 self-migration gate: the migrated <c>Gsharp.NET.Sdk</c>
/// (netstandard2.0) emitted the bad rows and the migrated <c>Sdk.Tests</c>
/// (net10.0) crashed reading them. It is the same family as #3755 — emitting a
/// reference to a type the consuming target does not have.
/// </para>
/// <para>
/// The test EXECUTES the final program: an assembly that merely "compiles" can
/// still carry an unresolvable metadata row, so the proof has to load it.
/// </para>
/// </summary>
public class Issue3811EmbeddedAttributeReferenceScopeTests
{
    // A third-party assembly carrying its own copy of the embeddable
    // attributes, exactly as csc embeds one into a netstandard2.0 assembly.
    private const string DonorSource = @"
package System.Runtime.CompilerServices

import System

internal class NullableAttribute : Attribute {
    init(b uint8) {}
}

internal class NullableContextAttribute : Attribute {
    init(b uint8) {}
}
";

    // A library with nullable-annotated surface, so the emitter is asked for
    // the attribute ctors at all.
    private const string LibrarySource = @"
package Lib

class Holder {
    var name string?
    func Get(input string?) string? -> input
}
";

    private const string ConsumerSource = @"
import System
import Lib

let h = Holder()
Console.WriteLine(h.Get(""hello""))
";

    /// <summary>
    /// A library compiled with the donor in its reference closure must be
    /// consumable — and runnable — by a compilation that does NOT have the
    /// donor. Before the fix the consumer compile died in the reference
    /// resolver (or, when a same-named assembly WAS present without the type,
    /// with the gate's <c>GS9998 TypeLoadException ... in assembly ''</c>).
    /// </summary>
    [Fact]
    public void LibraryBuiltWithADonorAssembly_IsConsumableWithoutIt()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3811_").FullName;
        try
        {
            var donorPath = Path.Combine(tempDir, "Donor.dll");
            CompileOrThrow("donor", DonorSource, donorPath, tempDir, target: "library", extraReferences: []);

            var libPath = Path.Combine(tempDir, "Lib.dll");

            // The donor is listed FIRST so it wins the resolver's first-writer
            // precedence — the position Microsoft.Build.Framework occupies for
            // the migrated SDK, whose netstandard2.0 closure has no core
            // library declaring the attribute at all.
            CompileOrThrow("lib", LibrarySource, libPath, tempDir, target: "library", extraReferences: [donorPath]);

            AssertNoForeignEmbeddableAttributeReference(libPath);

            var appPath = Path.Combine(tempDir, "App.dll");
            CompileOrThrow("app", ConsumerSource, appPath, tempDir, target: "exe", extraReferences: [libPath]);

            IlVerifier.Verify(appPath, additionalReferences: [libPath]);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the consumer must run. Exit {exit}:\n{output}");
            Assert.Equal("hello", output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// ANTI-VACUITY: the fix must not have silenced nullability emission
    /// wholesale. Compiled against the <b>targeting pack</b> — what every real
    /// SDK build uses, and where the core contract assembly
    /// (<c>System.Runtime</c>) genuinely declares the attributes — the rows are
    /// still emitted, scoped there.
    /// <para>
    /// The targeting pack is used rather than the test host's
    /// <c>TRUSTED_PLATFORM_ASSEMBLIES</c> precisely because the TPA set is full
    /// of third-party <c>netstandard2.0</c> assemblies carrying their own
    /// embedded copies — i.e. it is the defective input, not the reference one.
    /// </para>
    /// </summary>
    [Fact]
    public void AgainstTheTargetingPack_NullabilityRowsAreStillEmitted()
    {
        var referencePack = FindReferencePack();
        Assert.True(
            referencePack != null,
            "could not locate a Microsoft.NETCore.App.Ref targeting pack; this assertion is the "
                + "anti-vacuity guard for #3811 and must not be skipped silently.");

        var tempDir = Directory.CreateTempSubdirectory("gs_3811_pos_").FullName;
        try
        {
            var libPath = Path.Combine(tempDir, "Lib.dll");
            CompileOrThrow(
                "lib",
                LibrarySource,
                libPath,
                tempDir,
                target: "library",
                extraReferences: [],
                referenceSet: Directory.GetFiles(referencePack, "*.dll"));

            var scopes = EmbeddableAttributeReferenceScopes(libPath);
            Assert.NotEmpty(scopes);
            Assert.All(scopes, scope => Assert.Equal("System.Runtime", scope));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    // <dotnet-root>/packs/Microsoft.NETCore.App.Ref/<version>/ref/<tfm>
    private static string FindReferencePack()
    {
        var dotnetRoot = Path.GetDirectoryName(typeof(object).Assembly.Location);
        while (dotnetRoot != null && !Directory.Exists(Path.Combine(dotnetRoot, "packs")))
        {
            dotnetRoot = Path.GetDirectoryName(dotnetRoot);
        }

        if (dotnetRoot == null)
        {
            return null;
        }

        var packRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        if (!Directory.Exists(packRoot))
        {
            return null;
        }

        return Directory.GetDirectories(packRoot)
            .OrderByDescending(dir => dir, StringComparer.Ordinal)
            .Select(dir => Path.Combine(dir, "ref"))
            .Where(Directory.Exists)
            .SelectMany(refDir => Directory.GetDirectories(refDir).OrderByDescending(d => d, StringComparer.Ordinal))
            .FirstOrDefault(tfmDir => File.Exists(Path.Combine(tfmDir, "System.Runtime.dll")));
    }

    private static void AssertNoForeignEmbeddableAttributeReference(string assemblyPath)
    {
        var coreLibraryName = typeof(object).Assembly.GetName().Name;
        var foreign = EmbeddableAttributeReferenceScopes(assemblyPath)
            .Where(scope => !string.Equals(scope, coreLibraryName, StringComparison.Ordinal))
            .ToArray();
        Assert.True(
            foreign.Length == 0,
            "the emitted assembly scopes a compiler-embeddable attribute at a non-core assembly "
                + $"({string.Join(", ", foreign)}) — the #3811 defect.");
    }

    // The declaring-assembly name of every NullableAttribute /
    // NullableContextAttribute TypeRef in the assembly.
    private static IReadOnlyList<string> EmbeddableAttributeReferenceScopes(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var scopes = new List<string>();
        foreach (var handle in reader.TypeReferences)
        {
            var typeReference = reader.GetTypeReference(handle);
            var name = reader.GetString(typeReference.Name);
            if (name is not ("NullableAttribute" or "NullableContextAttribute"))
            {
                continue;
            }

            if (typeReference.ResolutionScope.Kind != HandleKind.AssemblyReference)
            {
                scopes.Add("<" + typeReference.ResolutionScope.Kind + ">");
                continue;
            }

            var assemblyReference = reader.GetAssemblyReference(
                (AssemblyReferenceHandle)typeReference.ResolutionScope);
            scopes.Add(reader.GetString(assemblyReference.Name));
        }

        return scopes;
    }

    private static void CompileOrThrow(
        string name,
        string source,
        string outPath,
        string tempDir,
        string target,
        string[] extraReferences,
        IEnumerable<string> referenceSet = null)
    {
        var srcPath = Path.Combine(tempDir, name + ".gs");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:" + target,
            "/targetframework:net10.0",
        };

        // Deliberately BEFORE the platform assemblies: the resolver keeps
        // first-writer precedence, and this reproduces the position the donor
        // occupies in the real reference closure.
        foreach (var reference in extraReferences)
        {
            args.Add("/reference:" + reference);
        }

        foreach (var reference in referenceSet ?? TrustedPlatformAssemblies())
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
        int exit;
        try
        {
            exit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            exit == 0,
            $"gsc failed compiling '{name}' (a GS9997/GS9998 here is the #3811 defect):\n"
                + $"stdout:\n{compileOut}\nstderr:\n{compileErr}");
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
