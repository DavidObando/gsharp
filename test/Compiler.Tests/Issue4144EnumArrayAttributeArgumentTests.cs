// <copyright file="Issue4144EnumArrayAttributeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4144: <c>@E([]Status{Status.Active})</c> — a 1-D array of an ENUM
/// as an attribute argument — was rejected by <c>GS0202</c>, whose own
/// message ("primitive, string, typeof, enum, or 1-D array thereof") says
/// this exact shape is permitted. ECMA-335 II.23.3 allows it and <c>csc</c>
/// accepts the identical C# shape with no diagnostic.
/// </summary>
/// <remarks>
/// <para><b>Scope, measured rather than assumed.</b> The issue named the
/// same-compilation case only and explicitly left open whether an IMPORTED
/// enum's array behaved the same way. Measured on <c>origin/main</c>: BOTH
/// fail, for two entirely unrelated reasons.</para>
/// <para><b>Same-compilation: the #3684/#4073 erasure family.</b> A
/// same-compilation enum has no <see cref="Type"/> (<c>ClrType</c>) until it
/// is emitted, and the array-argument binder gated on
/// <c>bound.Type.ClrType</c> being a non-null, rank-1 array — so
/// <c>[]Status{...}</c>'s array type, itself built from the elementless
/// enum, read as null and the whole array was rejected before any element
/// was even looked at. This is exactly the shape #4097's SCALAR enum fix
/// already had to look past (a same-compilation enum's underlying type is
/// always <c>int32</c>), just never extended to the array binder.</para>
/// <para><b>Imported: a plain coercion bug, unrelated to erasure.</b>
/// <c>[]DayOfWeek{...}</c>'s array type has a perfectly real, non-null
/// <c>ClrType</c> (<c>System.DayOfWeek[]</c>) and passed the old gate — the
/// failure was one step later. The constant-array coercion converted the
/// bound element (already the boxed UNDERLYING primitive, per #4097) to the
/// enum's underlying type again via <c>Convert.ChangeType</c>, which is a
/// no-op that leaves a boxed <c>int</c>; <c>Array.SetValue</c> then refused
/// to store an <c>int</c> into a <c>DayOfWeek[]</c> slot
/// (<c>InvalidCastException: "Object cannot be stored in an array of this
/// type."</c>), caught by a blanket <c>catch</c> and reported as the
/// misleading <c>GS0202</c>. Fixed with <c>Enum.ToObject</c>, which produces
/// the genuine boxed enum instance the array slot needs.</para>
/// <para><b>Reified, not merely accepted.</b> Compiling clean is not proof
/// enough for this class of bug (an attribute or type serialising to a name
/// that RESOLVES, just to the wrong thing) — both rows are read back through
/// a <see cref="MetadataLoadContext"/> and their array VALUES are asserted,
/// not merely their shape.</para>
/// </remarks>
public class Issue4144EnumArrayAttributeArgumentTests
{
    private const string SameCompilationSource = """
        package P
        import System

        enum Status {
            Active,
            Retired
        }

        class EAttribute(Kinds []Status) : Attribute {
        }

        @E([]Status{Status.Active, Status.Retired})
        class Target {
        }

        Console.WriteLine("ok")
        """;

    private const string ImportedSource = """
        package P
        import System

        class EAttribute(Kinds []DayOfWeek) : Attribute {
        }

        @E([]DayOfWeek{DayOfWeek.Monday, DayOfWeek.Friday})
        class Target {
        }

        Console.WriteLine("ok")
        """;

    [Fact]
    public void ASameCompilationEnumArrayAttributeArgument_CompilesAndReifiesCorrectly()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4144_samecomp_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "P.dll");
            var log = Compile(tempDir, "App.gs", SameCompilationSource, appPath, "/target:exe");

            var ids = ErrorIds(log);
            Assert.True(
                ids.Length == 0,
                $"a same-compilation enum-array attribute argument must compile clean. Reported: [{string.Join(", ", ids)}]\nLog:\n{log}");
            Assert.True(File.Exists(appPath), $"must produce an assembly. Log:\n{log}");

            IlVerifier.Verify(appPath);

            // `CustomAttributeTypedArgument.Value` always reads back an
            // enum-typed argument as its UNDERLYING primitive — a
            // documented quirk of the reflection API, not a G# defect (a
            // real, non-reflection-only enum cannot be boxed by an MLC, so
            // this is what .NET itself hands back regardless of how the
            // blob was written). `ArgumentType` is the half that proves the
            // metadata names what the source wrote: it must resolve to
            // `P.Status[]`, not `System.Int32[]` or anything else that
            // happens to also read back.
            var (argumentType, values) = ReadEnumArrayArgument(appPath, "Target");
            Assert.Equal("P.Status[]", argumentType);
            Assert.Equal(new object[] { 0, 1 }, values);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void AnImportedEnumArrayAttributeArgument_CompilesAndReifiesCorrectly()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4144_imported_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "P.dll");
            var log = Compile(tempDir, "App.gs", ImportedSource, appPath, "/target:exe");

            var ids = ErrorIds(log);
            Assert.True(
                ids.Length == 0,
                $"an imported enum-array attribute argument must compile clean. Reported: [{string.Join(", ", ids)}]\nLog:\n{log}");
            Assert.True(File.Exists(appPath), $"must produce an assembly. Log:\n{log}");

            IlVerifier.Verify(appPath);

            // Same underlying-value caveat as the same-compilation row
            // above; `ArgumentType` must resolve to `System.DayOfWeek[]`.
            var (argumentType, values) = ReadEnumArrayArgument(appPath, "Target");
            Assert.Equal("System.DayOfWeek[]", argumentType);
            Assert.Equal(new object[] { 1, 5 }, values);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static (string ArgumentType, object[] Values) ReadEnumArrayArgument(string assemblyPath, string typeName)
    {
        var paths = new List<string>(TrustedPlatformAssemblies()) { assemblyPath };
        using var context = new MetadataLoadContext(new PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)));
        var assembly = context.LoadFromAssemblyPath(assemblyPath);
        var target = assembly.GetTypes().Single(candidate => candidate.Name == typeName);
        var attribute = target.GetCustomAttributesData()
            .Single(candidate => candidate.AttributeType.Name == "EAttribute");
        var arrayArgument = attribute.ConstructorArguments.Single();
        var elements = Assert.IsAssignableFrom<IReadOnlyCollection<CustomAttributeTypedArgument>>(arrayArgument.Value);
        var values = elements.Select(element => element.Value).ToArray();
        return (arrayArgument.ArgumentType.FullName!, values);
    }

    private static string[] ErrorIds(string log)
        => Regex.Matches(log, @"error (GS[0-9]{4})")
            .Select(match => match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
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
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        return tpa.Split(Path.PathSeparator);
    }
}
