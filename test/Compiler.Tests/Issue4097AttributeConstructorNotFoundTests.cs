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
/// <para><b>The diagnostic immediately found a matcher gap, which is the whole
/// point of it.</b> Turning the drop into an error ran the Oahu corpus red on
/// <c>@ToString(typeof(ToStringConverterPath))</c>, against
/// <c>ToStringAttribute(Type type, string format = null)</c> — a trailing
/// OPTIONAL parameter, which no pass of <c>ResolveAttributeConstructor</c>
/// admitted. That program is legal C# and legal G#, so GS0583 was the WRONG
/// answer for it; the right one is to match the constructor and write the
/// default into the blob. It had been dropped from every Oahu assembly that
/// used it for as long as the corpus has been pinned, and nothing reported it.
/// Optional parameters are now a resolution pass of their own, placed before
/// params-array expansion because normal form beats expanded form — the same
/// order C# overload resolution uses. See <c>OmittedTrailingOptional</c> and
/// <see cref="OmittedOptionalDefaults_AreWrittenIntoTheBlob"/>, which asserts
/// the defaulted values are really in the metadata rather than merely
/// tolerated by the matcher.</para>
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

        // The shape the Oahu corpus uses, reproduced exactly: one required
        // parameter and one OPTIONAL one. Legal C#, legal G#, and matched by no
        // pass of the constructor resolver before #4097.
        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class ToStringAttribute : Attribute
        {
            public ToStringAttribute(Type type, string format = null)
            {
                Type = type;
                Format = format;
            }

            public Type Type { get; }

            public string Format { get; }
        }

        // The xunit shapes the cs2gs corpus actually uses. `MemberDataLike` is
        // the one that regressed: one required parameter plus a params tail
        // absorbing ZERO trailing elements, so fewer arguments are supplied
        // than there are slots — which is also true of a genuinely optional
        // tail, and is why the two must be told apart.
        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class MemberDataLikeAttribute : Attribute
        {
            public MemberDataLikeAttribute(string memberName, params object[] parameters)
            {
                MemberName = memberName;
                Parameters = parameters;
            }

            public string MemberName { get; }

            public object[] Parameters { get; }
        }

        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class InlineDataLikeAttribute : Attribute
        {
            public InlineDataLikeAttribute(params object[] data)
            {
                Data = data;
            }

            public object[] Data { get; }
        }

        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class OptionalsAttribute : Attribute
        {
            public OptionalsAttribute(int first, int second = 7, string third = "d")
            {
                First = first;
                Second = second;
                Third = third;
            }

            public int First { get; }

            public int Second { get; }

            public string Third { get; }
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

        // Issue #4097, found in the Oahu corpus rather than by reasoning: a
        // constructor reached through its trailing OPTIONAL parameter. Legal
        // C#, legal G#, and matched by NO pass of the resolver before this
        // change — so `@ToString(typeof(X))` was dropped from every Oahu
        // assembly that used it, silently, for as long as the corpus has been
        // pinned. The first draft of this fix reported GS0583 here, which is
        // the wrong answer: the program is one the language accepts, so the
        // attribute must be EMITTED with the default filled in.
        yield return new object[]
        {
            "OmittedTrailingOptional",
            "@ToString(typeof(Status))",
            new[] { "ToStringAttribute" },
        };

        // Two omitted optionals, one of them a value type with a non-zero
        // default — the blob carries a value per parameter, so `7` and `"d"`
        // have to be read out of the metadata, not merely tolerated.
        yield return new object[]
        {
            "OmittedTrailingOptionals",
            "@Optionals(1)",
            new[] { "OptionalsAttribute" },
        };

        // Issue #4097, caught by the cs2gs corpus gate: a params tail absorbing
        // ZERO trailing elements supplies fewer arguments than there are slots,
        // exactly as an omitted optional does. Conflating the two wrote `nil`
        // into the array slot instead of an empty array, and xunit stopped
        // seeing any data rows for the theory.
        yield return new object[]
        {
            "ParamsTailAbsorbingNothing",
            "@MemberDataLike(\"ShapeAreas\")",
            new[] { "MemberDataLikeAttribute" },
        };

        // The same constructor with elements to absorb: the expanded form.
        yield return new object[]
        {
            "ParamsTailAbsorbingElements",
            "@MemberDataLike(\"Cases\", 1, 2)",
            new[] { "MemberDataLikeAttribute" },
        };

        // A bare params constructor, the `[InlineData(...)]` shape.
        yield return new object[]
        {
            "BareParamsConstructor",
            "@InlineDataLike(1, \"small\")",
            new[] { "InlineDataLikeAttribute" },
        };

        // Supplying an optional explicitly must keep the exact-arity path.
        yield return new object[]
        {
            "SuppliedTrailingOptional",
            "@ToString(typeof(Status), \"G\")",
            new[] { "ToStringAttribute" },
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
    /// The OTHER silent-drop cause on the user-attribute path: the arguments DO
    /// match, but the constructor parameter is typed as a same-compilation
    /// enum, which has no <c>ClrType</c> while the attribute blob is built.
    /// Measured on this branch's parent: no diagnostic, and the
    /// <c>NoteAttribute</c> row absent from <c>Widget</c>.
    /// </summary>
    /// <remarks>
    /// <para>This is EMITTED, not diagnosed. The program is legal — <c>csc</c>
    /// accepts the C# equivalent — so a diagnostic is the wrong answer, which
    /// is the same lesson the Oahu corpus taught about trailing optional
    /// parameters. Oahu carries this exact shape too
    /// (<c>@OahuCapability(CapabilityClass.Safe)</c>), so an earlier draft that
    /// reported GS0584 here took four of its apps red.</para>
    /// <para>Encoding it is a substitution, not a feature: a G# enum's
    /// underlying type is always <c>int32</c>, the bound value is already that
    /// constant rather than a symbol, and the constructor token and signature
    /// come from the emitted <c>MethodDef</c> — so only the value's WIDTH was
    /// ever missing. ECMA-335 II.23.3 writes an enum-typed fixed argument as
    /// its underlying primitive, which is what this now does.</para>
    /// </remarks>
    [Fact]
    public void AUserAttributeConstructorParameterTypedAsASourceEnum_IsEmitted()
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

            @Note(Status.Retired)
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

            Assert.Empty(ErrorIds(log));
            Assert.True(File.Exists(appPath), $"the sample must compile. Log:\n{log}");

            IlVerifier.Verify(appPath, new[] { libPath });

            // The row lands, and the blob carries the enum's UNDERLYING value.
            // `Retired` is 1, so a reader that got 0 would mean the argument had
            // been written as a default rather than as what the source named.
            Assert.Equal(new[] { "NoteAttribute" }, EmittedAttributeNames(appPath, libPath, "Widget"));
            Assert.Equal(new object[] { 1 }, ConstructorArguments(appPath, libPath, "Widget"));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// GS0584's remaining population, measured: every shape that still reports
    /// it is one <c>csc</c> rejects as CS0181 — "not a valid attribute
    /// parameter type". There is no legal-but-unencodable residue.
    /// </summary>
    /// <remarks>
    /// G# has no bind-time CS0181 analogue — no descriptor mentions attribute
    /// parameter types, and the binder does not validate them — so these
    /// programs reach emit unchecked, where the old code dropped them in
    /// silence. GS0584 is the last line rather than the right place: the check
    /// belongs on the attribute's DECLARATION, and is filed separately.
    /// </remarks>
    /// <param name="name">The row name.</param>
    /// <param name="declaration">The attribute class declaration.</param>
    /// <param name="usage">The annotation applying it.</param>
    [Theory]
    [InlineData("SourceClass", "class BoxedAttribute(Value Holder) : Attribute {\n}", "@Boxed(nil)")]
    [InlineData("SourceInterface", "class ThingAttribute(Value IThing) : Attribute {\n}", "@Thing(nil)")]
    public void AnInvalidAttributeParameterType_ReportsGS0584(string name, string declaration, string usage)
    {
        const string ProbeSource = """
            package P
            import System

            class Holder {
            }

            interface IThing {
                func Get() int32;
            }


            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4097_bad_param_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var source = ProbeSource + declaration + "\n\n" + usage
                + "\nclass Target {\n}\n\nConsole.WriteLine(\"ok\")\n";
            var log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            var ids = ErrorIds(log);
            Assert.True(
                ids.Contains("GS0584", StringComparer.Ordinal),
                $"'{name}' must report GS0584. Reported: [{string.Join(", ", ids)}]\nLog:\n{log}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The defaults of omitted optional parameters must be WRITTEN into the
    /// blob, not merely tolerated by the matcher. ECMA-335 II.23.3 gives a
    /// fixed-argument list one entry per constructor parameter, so a reader
    /// gets `7` and `"d"` back or the row is malformed.
    /// </summary>
    [Fact]
    public void OmittedOptionalDefaults_AreWrittenIntoTheBlob()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4097_opt_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var source = Preamble
                + "@Optionals(1)\nclass Defaulted {\n}\n\n"
                + "@ToString(typeof(Status))\nclass Converted {\n}\n\n"
                + "Console.WriteLine(\"ok\")\n";
            var log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.Empty(ErrorIds(log));
            Assert.True(File.Exists(appPath), $"the sample must compile. Log:\n{log}");

            IlVerifier.Verify(appPath, new[] { libPath });

            Assert.Equal(new object[] { 1, 7, "d" }, ConstructorArguments(appPath, libPath, "Defaulted"));

            // The `Type` argument reifies; the omitted `string format` is nil,
            // which is what `format = null` means.
            Assert.Equal(
                new object[] { "P.Status", null },
                ConstructorArguments(appPath, libPath, "Converted"));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The regression the cs2gs corpus caught: a params tail that absorbs
    /// nothing must be written as an EMPTY ARRAY, not as <c>nil</c>.
    /// </summary>
    /// <remarks>
    /// Asserting the attribute merely lands is not enough — it landed before
    /// too. The blob was well-formed and said the wrong thing, which is why
    /// compile and ilverify both passed and only running the migrated tests
    /// exposed it. So the array itself is read back out of the metadata.
    /// </remarks>
    [Fact]
    public void AParamsTailAbsorbingNothing_IsWrittenAsAnEmptyArray()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4097_params_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var source = Preamble
                + "@MemberDataLike(\"ShapeAreas\")\nclass Empty {\n}\n\n"
                + "@MemberDataLike(\"Cases\", 1, 2)\nclass Filled {\n}\n\n"
                + "Console.WriteLine(\"ok\")\n";
            var log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.Empty(ErrorIds(log));
            Assert.True(File.Exists(appPath), $"the sample must compile. Log:\n{log}");

            IlVerifier.Verify(appPath, new[] { libPath });

            // Two slots: the name, then the params array. The array must be
            // present and EMPTY — `nil` here is what broke theory discovery.
            var empty = ConstructorArguments(appPath, libPath, "Empty");
            Assert.Equal(2, empty.Length);
            Assert.Equal("ShapeAreas", empty[0]);
            Assert.NotNull(empty[1]);
            Assert.Empty((IEnumerable<CustomAttributeTypedArgument>)empty[1]);

            // And the expanded form still packs its elements.
            var filled = ConstructorArguments(appPath, libPath, "Filled");
            Assert.Equal(2, filled.Length);
            Assert.Equal("Cases", filled[0]);
            Assert.Equal(
                new object[] { 1, 2 },
                ((IEnumerable<CustomAttributeTypedArgument>)filled[1]).Select(a => a.Value).ToArray());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>Reads the positional constructor arguments of the helper attribute on one type.</summary>
    /// <param name="assemblyPath">The emitted assembly.</param>
    /// <param name="libPath">The referenced helper library.</param>
    /// <param name="typeName">The annotated type's simple name.</param>
    /// <returns>The argument values, in parameter order.</returns>
    private static object[] ConstructorArguments(string assemblyPath, string libPath, string typeName)
    {
        var paths = new List<string>(TrustedPlatformAssemblies())
        {
            assemblyPath,
            libPath,
        };

        using var context = new MetadataLoadContext(new PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)));
        var assembly = context.LoadFromAssemblyPath(assemblyPath);
        var target = assembly.GetTypes().Single(candidate => candidate.Name == typeName);

        // Same predicate as EmittedAttributeNames: a same-compilation user
        // attribute lives in the compilation's own package, not the helper lib.
        var attribute = target.GetCustomAttributesData()
            .Single(candidate =>
                candidate.AttributeType.Namespace?.StartsWith("HelperLib4097", StringComparison.Ordinal) == true
                || candidate.AttributeType.Name == "NoteAttribute");

        // Projected to a name WHILE the context is alive: a reflection `Type`
        // read after the load context is disposed throws.
        return attribute.ConstructorArguments
            .Select(argument => argument.Value is Type type
                ? (object)(type.FullName ?? type.Name)
                : argument.Value)
            .ToArray();
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
