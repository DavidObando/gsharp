// <copyright file="Issue4247ZeroLengthAttributeArrayTests.cs" company="GSharp">
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
/// Issue #4247: <c>[N]T</c> written with NO initializer at all (not even
/// empty braces <c>{}</c>) parses as the runtime/zero-initialised allocation
/// form (issue #1272) — its length lives in
/// <c>ArrayCreationExpressionSyntax.LengthExpression</c>, and binding it
/// produces a <c>BoundArrayCreationExpression</c> with NO element list at
/// all (<c>ArrayCreationExpressionSyntax.Elements</c> stays
/// <see langword="null"/>). <c>DeclarationBinder.TryBindAttributeArrayArgument</c>
/// unconditionally required <c>syntax.Elements</c> to be present, so even
/// the constant, zero-length spelling <c>[0]Kind</c> was rejected with
/// <c>GS0202</c> — although Roslyn accepts the equivalent <c>new
/// Kind[0]</c>, and G#'s own explicit-empty-initializer spellings
/// (<c>[]Kind{}</c>, <c>[0]Kind{}</c>) already worked, since THOSE populate
/// <c>Elements</c> with zero items rather than leaving it null.
///
/// Fixed by accepting the no-initializer form once its length resolves to
/// the literal constant <c>0</c> (a zero-length SZARRAY is exactly as
/// constant and serialisable as an explicit empty initializer); any other
/// runtime length — a variable, or a nonzero constant with no initializer
/// to supply its elements — still has no constant element list to
/// serialize and correctly keeps reporting <c>GS0202</c>.
/// </summary>
public class Issue4247ZeroLengthAttributeArrayTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NoInitializerZeroLengthArray_CompilesAndReifiesAsEmptyArray(bool imported)
    {
        var elementType = imported ? "DayOfWeek" : "Kind";
        var enumDeclaration = imported ? string.Empty : "enum Kind { First = 7 }\n";
        var tempDir = Directory.CreateTempSubdirectory("gs_4247_zero_len_").FullName;
        try
        {
            var source = $$"""
                package P
                import System
                {{enumDeclaration}}class EAttribute(Values []{{elementType}}) : Attribute {}
                @E([0]{{elementType}})
                class Target {}
                Console.WriteLine("ok")
                """;
            var appPath = Path.Combine(tempDir, "P.dll");
            var log = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            var ids = ErrorIds(log);
            Assert.True(
                ids.Length == 0,
                $"a no-initializer zero-length attribute array argument must compile clean. Reported: [{string.Join(", ", ids)}]\nLog:\n{log}");
            Assert.True(File.Exists(appPath), $"must produce an assembly. Log:\n{log}");

            IlVerifier.Verify(appPath);

            var (argumentType, values) = ReadArrayArgument(appPath, "Target");
            Assert.Equal(imported ? "System.DayOfWeek[]" : "P.Kind[]", argumentType);
            Assert.Empty(values);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Parity control: the explicit empty-initializer spelling must keep
    /// working identically (this is the shape the issue says already
    /// worked "after the scoped serialization fix" — #4245/#4249).
    /// </summary>
    [Fact]
    public void ExplicitEmptyInitializer_StillCompilesAndReifiesAsEmptyArray()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4247_explicit_empty_").FullName;
        try
        {
            const string Source = """
                package P
                import System
                enum Kind { First = 7 }
                class EAttribute(Values []Kind) : Attribute {}
                @E([]Kind{})
                class Target {}
                Console.WriteLine("ok")
                """;
            var appPath = Path.Combine(tempDir, "P.dll");
            var log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");

            Assert.True(ErrorIds(log).Length == 0, log);
            Assert.True(File.Exists(appPath), log);

            IlVerifier.Verify(appPath);

            var (argumentType, values) = ReadArrayArgument(appPath, "Target");
            Assert.Equal("P.Kind[]", argumentType);
            Assert.Empty(values);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A nonzero constant length with no initializer has no element list to
    /// serialize and must keep reporting GS0202 — the fix is scoped to the
    /// zero-length case, not a general default-value-filled allocation.
    /// </summary>
    [Fact]
    public void NonzeroLengthWithNoInitializer_StillRejected()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4247_nonzero_len_").FullName;
        try
        {
            const string Source = """
                package P
                import System
                enum Kind { First = 7 }
                class EAttribute(Values []Kind) : Attribute {}
                @E([3]Kind)
                class Target {}
                Console.WriteLine("ok")
                """;
            var appPath = Path.Combine(tempDir, "P.dll");
            var log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");

            Assert.Contains("GS0202", ErrorIds(log));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A nonconstant length (a variable) with no initializer must keep
    /// reporting GS0202 — only a literal-constant zero length is accepted.
    /// </summary>
    [Fact]
    public void NonconstantLengthWithNoInitializer_StillRejected()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4247_nonconst_len_").FullName;
        try
        {
            const string Source = """
                package P
                import System
                enum Kind { First = 7 }
                class EAttribute(Values []Kind) : Attribute {}
                func Length() int32 { return 0 }
                @E([Length()]Kind)
                class Target {}
                Console.WriteLine("ok")
                """;
            var appPath = Path.Combine(tempDir, "P.dll");
            var log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");

            Assert.Contains("GS0202", ErrorIds(log));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static (string ArgumentType, object[] Values) ReadArrayArgument(string assemblyPath, string typeName)
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
