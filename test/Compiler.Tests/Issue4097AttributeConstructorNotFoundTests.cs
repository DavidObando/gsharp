// <copyright file="Issue4097AttributeConstructorNotFoundTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4097: an attribute whose arguments match no constructor of the
/// attribute type was DROPPED from the emitted assembly with no diagnostic at
/// all — exit 0, IL-verifies, runs, and the annotation the author wrote is
/// simply not in the metadata.
/// </summary>
/// <remarks>
/// <para><b>The defect is silence, not selection.</b>
/// <c>ResolveAttributeConstructor</c> returning "no candidate matched" is the
/// correct answer for these programs; treating it as "nothing to emit" rather
/// than as an error is the bug. That silence is how issue #4073's
/// <c>Type[]</c> half stayed invisible: a widened <c>object[]</c> container
/// failed a <c>Type[]</c> parameter match, the WHOLE attribute vanished, and
/// the only symptom was a downstream framework not seeing an annotation that
/// was plainly in the source.</para>
/// <para><b>Both drop sites.</b> The CLR-imported path bails when
/// <c>ResolveAttributeConstructor</c> returns null; the same-compilation user
/// attribute path (issue #1921) bails when
/// <c>TryResolveUserAttributeConstructor</c> returns false. Both are covered.
/// The user path has a second, honestly different cause — a constructor
/// parameter typed as an as-yet-unemitted user type, which the encoder cannot
/// write — and that gets its own message rather than being told it has the
/// wrong arguments.</para>
/// <para><b>Emit-time, and why.</b> The check is the emitter's own
/// applicability rule (<c>ArgAssignable</c> over the RESOLVED constructor set,
/// including params-array expansion), and the emit pipeline has no
/// <c>DiagnosticBag</c> in scope. It reports through the same channel GS0546
/// uses: an <c>EmitDiagnosticException</c> carrying a diagnostic id, anchored
/// at the annotation. The consequence is that the first offending attribute
/// aborts emit, so a program with several reports one — the same limitation
/// GS0546 has, and still infinitely better than silence.</para>
/// <para><b>This is also the #4087 non-regression proof.</b> PR #4087 narrowed
/// <c>ArgAssignable</c>'s widened-array arm so <c>[]object{"x"}</c> no longer
/// satisfies a <c>string[]</c> constructor. That narrowing routed such programs
/// back into this silent drop. The <c>WidenedStringsAtStringArray</c> and
/// <c>ObjectContainerAtTypeArray</c> rows assert they now DIAGNOSE — which can
/// only happen if the narrowing still refuses them. If #4087 regressed, those
/// two rows would compile clean and fail here.</para>
/// </remarks>
public class Issue4097AttributeConstructorNotFoundTests
{
    /// <summary>The diagnostic an unmatched attribute constructor reports.</summary>
    private const string ExpectedId = "GS0583";

    private const string LibrarySource = """
        using System;

        namespace HelperLib4097;

        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class NamesAttribute : Attribute
        {
            public NamesAttribute(string[] values)
            {
                Values = values;
            }

            public string[] Values { get; }
        }

        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class ManyAttribute : Attribute
        {
            public ManyAttribute(Type[] values)
            {
                Values = values;
            }

            public Type[] Values { get; }
        }

        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class MarkerAttribute : Attribute
        {
            public MarkerAttribute(Type value)
            {
                Value = value;
            }

            public Type Value { get; }
        }
        """;

    private const string Preamble = """
        package P
        import System
        import HelperLib4097

        enum Status {
            Active,
            Retired
        }

        class NoteAttribute(Text string) : Attribute {
        }


        """;

    /// <summary>
    /// Every shape whose arguments match no constructor. Each is its own
    /// compilation because the emit-time channel aborts on the first one.
    /// </summary>
    /// <returns>Row name and the annotated declaration.</returns>
    public static IEnumerable<object[]> UnmatchedRows()
    {
        // The issue's own row, verbatim.
        yield return new object[]
        {
            "ObjectContainerAtTypeArray",
            "@Many([]object{1})",
        };

        // PR #4087's narrowing: a source `object[]` at a `string[]` parameter
        // is a call the author could not have written.
        yield return new object[]
        {
            "WidenedStringsAtStringArray",
            "@Names([]object{\"x\"})",
        };

        // Same narrowing, the `Type[]` parameter it was introduced for.
        yield return new object[]
        {
            "ObjectContainerOfTypesAtTypeArray",
            "@Many([]object{typeof(Status)})",
        };

        // No constructor of that arity at all — C#'s CS1729.
        yield return new object[]
        {
            "TooManyArguments",
            "@Marker(typeof(Status), typeof(Status))",
        };

        // Right arity, unassignable scalar — C#'s CS1503.
        yield return new object[]
        {
            "WrongScalarType",
            "@Marker(1)",
        };

        // The same-compilation user-attribute path (issue #1921).
        yield return new object[]
        {
            "UserAttributeWrongArity",
            "@Note(\"a\", \"b\")",
        };

        yield return new object[]
        {
            "UserAttributeWrongScalarType",
            "@Note(1)",
        };
    }

    /// <summary>
    /// Shapes that DO match a constructor. They must keep compiling clean and
    /// keep landing a CustomAttribute row — a diagnostic that fires here would
    /// be a far worse regression than the silence it replaces.
    /// </summary>
    /// <returns>Row name, annotated declaration, expected attribute names.</returns>
    public static IEnumerable<object[]> MatchedRows()
    {
        yield return new object[]
        {
            "FaithfulStringArray",
            "@Names([]string{\"x\"})",
            new[] { "NamesAttribute" },
        };

        // The container #3684 widened, at the parameter it was widened FOR.
        yield return new object[]
        {
            "WidenedTypeArray",
            "@Many([]Type{typeof(Status)})",
            new[] { "ManyAttribute" },
        };

        yield return new object[]
        {
            "ScalarType",
            "@Marker(typeof(Status))",
            new[] { "MarkerAttribute" },
        };

        yield return new object[]
        {
            "UserAttributeMatched",
            "@Note(\"hello\")",
            new[] { "NoteAttribute" },
        };
    }

    [Theory]
    [MemberData(nameof(UnmatchedRows))]
    public void AnAttributeMatchingNoConstructor_ReportsADiagnostic(string name, string annotation)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4097_bad_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var source = Preamble
                + annotation + "\nclass " + name + " {\n}\n\nConsole.WriteLine(\"ok\")\n";
            var log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            var ids = ErrorIds(log);

            // The failure message names BOTH halves of the defect on purpose.
            // "No diagnostic was reported" alone does not prove the bug this
            // issue describes; what makes it data LOSS is that the annotation
            // is missing from the metadata too. Measured on this branch's
            // parent, every row here reported `ids=[] attrs=[]` — clean
            // compile, attribute gone.
            var attributes = File.Exists(appPath)
                ? EmittedAttributeNames(appPath, libPath, name)
                : new[] { "<emit aborted>" };
            Assert.True(
                ids.Contains(ExpectedId, StringComparer.Ordinal),
                $"'{name}' must report {ExpectedId}. ids=[{string.Join(", ", ids)}] "
                    + $"attrs=[{string.Join(", ", attributes)}]\nLog:\n{log}");

            // Never dressed up as an internal compiler error.
            Assert.DoesNotContain("GS9998", ids);

            // And the row is genuinely not emitted — the diagnostic replaced the
            // silence, it did not paper over a half-written attribute.
            Assert.Equal(new[] { "<emit aborted>" }, attributes);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(MatchedRows))]
    public void AnAttributeMatchingAConstructor_StillCompilesAndIsEmitted(
        string name,
        string annotation,
        string[] expectedAttributes)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4097_ok_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var source = Preamble
                + annotation + "\nclass " + name + " {\n}\n\nConsole.WriteLine(\"ok\")\n";
            var log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.Empty(ErrorIds(log));
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{log}");

            IlVerifier.Verify(appPath, new[] { libPath });

            Assert.Equal(expectedAttributes, EmittedAttributeNames(appPath, libPath, name));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The OTHER silent-drop cause on the user-attribute path, and a genuinely
    /// different one: the arguments DO match, but the constructor parameter is
    /// typed as a same-compilation enum, which has no <c>ClrType</c> while the
    /// attribute blob is built. Measured on this branch's parent: no
    /// diagnostic, and the <c>NoteAttribute</c> row absent from
    /// <c>Widget</c>.
    /// </summary>
    /// <remarks>
    /// This is not the user's mistake — the program is legal and a
    /// same-compilation enum is a perfectly good attribute-argument type — so
    /// it must NOT be told it has the wrong arguments. It gets GS0584, in the
    /// spirit of GS0466: a construct that is not implemented yet says so
    /// instead of vanishing. Supporting it properly is filed as issue #4135,
    /// and this row is the one to flip when that lands.
    /// </remarks>
    [Fact]
    public void AUserAttributeConstructorParameterTypedAsASourceEnum_ReportsItsOwnDiagnostic()
    {
        const string ProbeSource = """
            package P
            import System

            enum Status {
                Active,
                Retired
            }

            class NoteAttribute(Kind Status) : Attribute {
            }

            @Note(Status.Active)
            class Widget {
            }

            Console.WriteLine("ok")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4097_probe_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var log = Compile(tempDir, "App.gs", ProbeSource + "\n", appPath, "/target:exe", "/reference:" + libPath);

            var ids = ErrorIds(log);
            Assert.True(
                ids.Contains("GS0584", StringComparer.Ordinal),
                $"must report GS0584. Reported: [{string.Join(", ", ids)}]\nLog:\n{log}");

            // Not the "wrong arguments" message — the arguments are right.
            Assert.DoesNotContain(ExpectedId, ids);
            Assert.DoesNotContain("GS9998", ids);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] ErrorIds(string log)
        => Regex.Matches(log, @"error (GS[0-9]{4})")
            .Select(match => match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    /// <summary>
    /// Names the user/helper attributes actually written onto one type.
    /// Distinguishes "encoded" from "dropped", which an argument list cannot.
    /// </summary>
    /// <param name="assemblyPath">The emitted assembly.</param>
    /// <param name="libPath">The referenced helper library.</param>
    /// <param name="typeName">The annotated type's simple name.</param>
    /// <returns>The attribute type names, in metadata order.</returns>
    private static string[] EmittedAttributeNames(string assemblyPath, string libPath, string typeName)
    {
        var paths = new List<string>(TrustedPlatformAssemblies())
        {
            assemblyPath,
            libPath,
        };

        using var context = new MetadataLoadContext(new PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)));
        var assembly = context.LoadFromAssemblyPath(assemblyPath);
        var target = assembly.GetTypes().Single(candidate => candidate.Name == typeName);

        return target.GetCustomAttributesData()
            .Where(attribute =>
                attribute.AttributeType.Namespace?.StartsWith("HelperLib4097", StringComparison.Ordinal) == true
                || attribute.AttributeType.Name == "NoteAttribute")
            .Select(attribute => attribute.AttributeType.Name)
            .ToArray();
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "HelperLib4097",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib4097.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "the C# library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        return libPath;
    }

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
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
