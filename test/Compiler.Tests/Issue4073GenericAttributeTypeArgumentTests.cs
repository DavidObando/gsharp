// <copyright file="Issue4073GenericAttributeTypeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4073: the <c>System.Type</c> argument of a custom attribute wrote the
/// ERASED closed CLR shape of a constructed generic into the blob, so
/// <c>@JsonConverter(typeof(JsonStringEnumConverter[ConstructStatus]))</c>
/// serialised <c>JsonStringEnumConverter`1[[System.Int32, …]]</c> and reflection
/// materialisation threw
/// <c>GenericArguments[0], System.Int32, on JsonStringEnumConverter&lt;TEnum&gt;
/// violates TEnum : struct, Enum</c>.
/// </summary>
/// <remarks>
/// <para><b>Root cause.</b> A same-compilation type has no <c>ClrType</c> while
/// binding, so a constructed imported generic over one is closed over a
/// surrogate and the real argument is kept only on the symbolic vector
/// (<c>ImportedTypeSymbol.TypeArguments</c>). <c>TryBindAttributeArgument</c>'s
/// <c>typeof</c> case preferred <c>operandType.ClrType</c> whenever it was
/// non-null — and for a constructed generic it always is, because the erased
/// close is a real closed type. So the encoder was handed the surrogate and
/// wrote its assembly-qualified name.</para>
/// <para><b>The enum is not special.</b> The issue names an enum because that is
/// what the self-migration gate hit, and the surrogate for a source enum is
/// <c>System.Int32</c> (issue #2391's deliberate ride-through). Measured across
/// the argument kinds, a same-compilation CLASS in the same position wrote
/// <c>System.Object</c>, a nested generic wrote the surrogate at depth, a
/// two-parameter generic wrote one of each, a slice argument wrote
/// <c>System.Int32[]</c>, and a nilable enum wrote <c>System.Object</c>. One
/// defect, five surrogates.</para>
/// <para><b>Two more sibling kinds, found by sweeping rather than reasoning.</b>
/// (1) A same-compilation GENERIC — <c>typeof(MyBox[Status])</c> — serialised as
/// the bare <c>P.MyBox</c>: the constructed <c>StructSymbol</c> carries its
/// arguments on <c>TypeArguments</c> and leaves <c>TypeParameters</c> empty, so
/// the arity suffix computed to zero and no argument list was written at all.
/// That name does not resolve, so the attribute could not be decoded — with an
/// IMPORTED argument (<c>MyBox[int32]</c>) too, which has nothing to do with
/// erasure. (2) An attribute whose <c>Type[]</c> argument contains a
/// same-compilation <c>typeof</c> was dropped from the assembly ENTIRELY, with
/// no diagnostic: #3684 widened the constant CONTAINER to <c>object[]</c> to
/// hold the <c>TypeSymbol</c> placeholder, and the constructor matcher then
/// refused <c>object[]</c> for a <c>Type[]</c> parameter.</para>
/// <para><b>A third kind, from the review sweep: a constructed generic
/// DELEGATE.</b> <c>DelegateTypeSymbol.CreateConstructed</c> keeps the vector on
/// <c>TypeArguments</c> like a struct does, but unlike a struct it PRESERVES
/// <c>TypeParameters</c>, so the arity suffix was already right and
/// <c>typeof(Pred[Status])</c> serialised as the open <c>P.Pred`1</c> — a name
/// that resolves, quietly dropping the argument. Nested as an argument
/// (<c>Box[Pred[Status]]</c>) it was worse: an open generic in an instantiation
/// slot reifies to a type with no <c>FullName</c> at all.</para>
/// <para><b>Constructor SELECTION, not just encoding.</b> The
/// <c>Type[]</c> repair widens what <c>ArgAssignable</c> admits, and
/// <c>ArgAssignable</c> is the applicability rule. Scoped to the container the
/// compiler itself widened — asked of <c>BoundAttributeArgument.Type</c>, the
/// type the AUTHOR wrote — it must not make every <c>object[]</c> covariant by
/// its current element values. See
/// <see cref="OnlyTheWidenedTypeArrayContainerSatisfiesAnArrayConstructor"/>.</para>
/// <para><b>ILVerify is not the discriminator here.</b> The blob is metadata,
/// not IL: every row verified before the fix and verifies after it. Each row is
/// still IL-verified — a metadata repair that broke the IL would be a
/// regression — but what tells the rows apart is the REIFIED type read back out
/// of the emitted assembly through a <see cref="MetadataLoadContext"/>, and, for
/// the issue's own shape, a program that runs and serialises.</para>
/// <para><b>Reified, not printed.</b> Every assertion describes the argument by
/// walking its generic definition and arguments and naming each part's declaring
/// ASSEMBLY. A printed type name can read correctly while the TypeSpec is
/// wrong.</para>
/// <para><b>What is deliberately NOT covered.</b> A nested type inside a generic
/// OUTER — <c>typeof(Outer[Status].Inner)</c> — loses its enclosing type
/// argument and serialises as the open <c>P.Outer`1+Inner</c>. That name
/// RESOLVES, so it fails quietly rather than loudly, and it needs a different
/// vector (<c>StructSymbol.ConstructNested</c> records the arguments on
/// <c>EnclosingTypeArguments</c> and leaves <c>TypeArguments</c> empty) plus a
/// decision about what arity the nested TypeDef declares. Measured on both sides
/// of this fix and filed as issue #4095. A G# STRUCTURAL type over a
/// same-compilation component — <c>Box[map[string, Status]]</c>,
/// <c>Box[(int32, Status)]</c>, <c>Box[func(Status) bool]</c>,
/// <c>Box[chan[Status]]</c>, <c>Box[sequence[Status]]</c> — serialises its G#
/// SPELLING (<c>map</c>, <c>(Status) -&gt; bool</c>) because the symbol's own
/// <c>ClrType</c> is null and the default arm falls back to <c>type.Name</c>.
/// FIVE kinds, and three of them need a projection DECIDED before they can be
/// written (<c>ValueTuple</c>'s <c>TRest</c> nesting above arity 7, <c>Func</c>
/// versus <c>Action</c> — by-ref parameters have neither — and the channel
/// direction), so repairing the two that are plain lookups would leave three
/// siblings undecodable. Filed as issue #4098, measured on this side; the claim
/// that the parent behaves identically is reasoning from the serialiser that
/// was replaced (a single <c>GetMetadataTypeName</c> plus one assembly name,
/// which reaches the same fallback), not a measurement, and issue #4098 says
/// so. The same kinds over an IMPORTED component already serialise correctly,
/// which is what identifies the trigger. Repaired since, in
/// <see cref="Issue4098StructuralAttributeTypeArgumentTests"/>.</para>
/// <para><b>Almost no new diagnostic.</b> Every program in this file's
/// <see cref="AnAttributeTypeArgument_ReifiesToTheTypeTheSourceNames"/> rows is
/// legal and was accepted before; only the metadata it emitted was wrong. The
/// two source-illegal rows in
/// <see cref="OnlyTheWidenedTypeArrayContainerSatisfiesAnArrayConstructor"/>
/// are the exception: they used to be dropped silently and now report GS0583
/// (issue #4097).</para>
/// </remarks>
public class Issue4073GenericAttributeTypeArgumentTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library every row links against. <c>Constrained&lt;TEnum&gt;</c>
    /// reproduces the constraint from the issue's <c>JsonStringEnumConverter</c>
    /// without depending on <c>System.Text.Json</c>'s shape.
    /// </summary>
    private const string LibrarySource = """
        using System;

        namespace HelperLib4073;

        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class MarkerAttribute : Attribute
        {
            public MarkerAttribute(Type value)
            {
                Value = value;
            }

            public Type Value { get; }

            public Type? Named { get; set; }

            public Type[]? Many { get; set; }
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

        // Review feedback on PR #4087: a `string[]` constructor, so the widened
        // `object[]` container has an unrelated array parameter to be tested
        // against. Nothing here takes a `Type`.
        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class NamesAttribute : Attribute
        {
            public NamesAttribute(string[] values)
            {
                Values = values;
            }

            public string[] Values { get; }
        }

        public class Box<T>
        {
        }

        public class Pair<TA, TB>
        {
        }

        public class Constrained<TEnum>
            where TEnum : struct, Enum
        {
        }

        public static class Probe
        {
            public static string DescribeMarker(Type target)
            {
                var marker = (MarkerAttribute)Attribute.GetCustomAttribute(target, typeof(MarkerAttribute))!;
                return marker.Value.GetGenericArguments()[0].FullName!;
            }
        }
        """;

    /// <summary>
    /// The declarations every row's program shares: a source enum, a source
    /// class, and a source generic, so a row's body is only the annotated type.
    /// </summary>
    private const string Preamble = """
        package P
        import System
        import HelperLib4073

        enum Status {
            Active,
            Retired
        }

        class Local {
        }

        class MyBox[T] {
            prop V T
        }

        delegate Pred[T](value T) bool;

        delegate Plain(value int32);

        """;

    /// <summary>
    /// Every attribute-argument kind that carries a <c>System.Type</c>. The
    /// expected value is a structural description of the REIFIED argument: a
    /// constructed generic reads as
    /// <c>Def`N@DefAssembly[Arg@ArgAssembly, …]</c>, so a row cannot pass by
    /// printing a plausible name — the argument's declaring assembly is part of
    /// the assertion, and the surrogates this issue emitted
    /// (<c>System.Int32@System.Private.CoreLib</c>,
    /// <c>System.Object@System.Private.CoreLib</c>) are distinct strings.
    /// </summary>
    /// <returns>Case name, the annotated G# declaration, and the expected reified arguments in order.</returns>
    public static IEnumerable<object[]> TypeArguments()
    {
        // --- The issue's shape and its argument-kind siblings. ---
        yield return new object[]
        {
            "constructed-generic-over-source-enum",
            """
            @Marker(typeof(Box[Status]))
            class Target {
            }
            """,
            new[] { "HelperLib4073.Box`1@HelperLib4073[P.Status@P]" },
        };

        yield return new object[]
        {
            "constructed-generic-over-source-class",
            """
            @Marker(typeof(Box[Local]))
            class Target {
            }
            """,
            new[] { "HelperLib4073.Box`1@HelperLib4073[P.Local@P]" },
        };

        yield return new object[]
        {
            "nested-constructed-generic-over-source-enum",
            """
            @Marker(typeof(Box[Box[Status]]))
            class Target {
            }
            """,
            new[] { "HelperLib4073.Box`1@HelperLib4073[HelperLib4073.Box`1@HelperLib4073[P.Status@P]]" },
        };

        yield return new object[]
        {
            "two-parameter-generic-over-source-enum-and-class",
            """
            @Marker(typeof(Pair[Status, Local]))
            class Target {
            }
            """,
            new[] { "HelperLib4073.Pair`2@HelperLib4073[P.Status@P,P.Local@P]" },
        };

        yield return new object[]
        {
            "slice-of-source-enum-as-argument",
            """
            @Marker(typeof(Box[[]Status]))
            class Target {
            }
            """,
            new[] { "HelperLib4073.Box`1@HelperLib4073[P.Status@P[]]" },
        };

        yield return new object[]
        {
            "nilable-source-enum-as-argument",
            """
            @Marker(typeof(Box[Status?]))
            class Target {
            }
            """,
            new[] { "HelperLib4073.Box`1@HelperLib4073[System.Nullable`1@System.Private.CoreLib[P.Status@P]]" },
        };

        // The reported failure mode: a generic whose parameter is CONSTRAINED,
        // so reflection materialisation refuses the surrogate outright.
        yield return new object[]
        {
            "constrained-generic-over-source-enum",
            """
            @Marker(typeof(Constrained[Status]))
            class Target {
            }
            """,
            new[] { "HelperLib4073.Constrained`1@HelperLib4073[P.Status@P]" },
        };

        // --- Argument POSITIONS. Same defect, three different encoders. ---
        yield return new object[]
        {
            "named-argument",
            """
            @Marker(typeof(string), Named: typeof(Box[Status]))
            class Target {
            }
            """,
            new[] { "System.String@System.Private.CoreLib", "HelperLib4073.Box`1@HelperLib4073[P.Status@P]" },
        };

        yield return new object[]
        {
            "array-element-in-named-argument",
            """
            @Marker(typeof(string), Many: []Type{typeof(Box[Status])})
            class Target {
            }
            """,
            new[] { "System.String@System.Private.CoreLib", "HelperLib4073.Box`1@HelperLib4073[P.Status@P]" },
        };

        yield return new object[]
        {
            "array-positional-argument",
            """
            @Many([]Type{typeof(Box[Status]), typeof(Local)})
            class Target {
            }
            """,
            new[] { "HelperLib4073.Box`1@HelperLib4073[P.Status@P]", "P.Local@P" },
        };

        // The whole attribute vanished when a Type[] held a same-compilation
        // scalar typeof: the widened `object[]` container failed the ctor match.
        yield return new object[]
        {
            "array-of-source-scalars",
            """
            @Many([]Type{typeof(Status), typeof(Local)})
            class Target {
            }
            """,
            new[] { "P.Status@P", "P.Local@P" },
        };

        // --- A same-compilation generic: a different branch, same wrong name. ---
        yield return new object[]
        {
            "source-generic-over-source-enum",
            """
            @Marker(typeof(MyBox[Status]))
            class Target {
            }
            """,
            new[] { "P.MyBox`1@P[P.Status@P]" },
        };

        yield return new object[]
        {
            "source-generic-over-imported-argument",
            """
            @Marker(typeof(MyBox[int32]))
            class Target {
            }
            """,
            new[] { "P.MyBox`1@P[System.Int32@System.Private.CoreLib]" },
        };

        // --- A constructed generic DELEGATE. Review feedback on PR #4087: the
        // kind the first sweep missed, and it fails one step further along than
        // the source-generic rows above. `CreateConstructed` PRESERVES
        // `TypeParameters`, so the arity suffix is right and `P.Pred`1`
        // RESOLVES — to the open definition, silently losing the argument.
        yield return new object[]
        {
            "constructed-delegate-over-source-enum",
            """
            @Marker(typeof(Pred[Status]))
            class Target {
            }
            """,
            new[] { "P.Pred`1@P[P.Status@P]" },
        };

        yield return new object[]
        {
            "constructed-delegate-over-source-class",
            """
            @Marker(typeof(Pred[Local]))
            class Target {
            }
            """,
            new[] { "P.Pred`1@P[P.Local@P]" },
        };

        // Erasure is not what breaks this one: an IMPORTED argument lost the
        // instantiation just the same, exactly as `MyBox[int32]` did.
        yield return new object[]
        {
            "constructed-delegate-over-imported-argument",
            """
            @Marker(typeof(Pred[int32]))
            class Target {
            }
            """,
            new[] { "P.Pred`1@P[System.Int32@System.Private.CoreLib]" },
        };

        // Nested as an ARGUMENT it is worse than a wrong name: the blob named an
        // open generic in an instantiation slot, so the reified type had no
        // `FullName` at all.
        yield return new object[]
        {
            "imported-generic-over-constructed-delegate",
            """
            @Marker(typeof(Box[Pred[Status]]))
            class Target {
            }
            """,
            new[] { "HelperLib4073.Box`1@HelperLib4073[P.Pred`1@P[P.Status@P]]" },
        };

        yield return new object[]
        {
            "source-generic-over-constructed-delegate",
            """
            @Marker(typeof(MyBox[Pred[Status]]))
            class Target {
            }
            """,
            new[] { "P.MyBox`1@P[P.Pred`1@P[P.Status@P]]" },
        };

        // --- Controls. Already correct before the fix; must not move. ---
        yield return new object[]
        {
            "non-generic-delegate",
            """
            @Marker(typeof(Plain))
            class Target {
            }
            """,
            new[] { "P.Plain@P" },
        };

        // The OPEN definition still serialises as the open definition — the
        // constructed arm must not fire on an empty argument vector.
        yield return new object[]
        {
            "open-generic-delegate",
            """
            @Marker(typeof(Pred))
            class Target {
            }
            """,
            new[] { "P.Pred`1@P" },
        };

        yield return new object[]
        {
            "scalar-source-enum",
            """
            @Marker(typeof(Status))
            class Target {
            }
            """,
            new[] { "P.Status@P" },
        };

        yield return new object[]
        {
            "scalar-source-class",
            """
            @Marker(typeof(Local))
            class Target {
            }
            """,
            new[] { "P.Local@P" },
        };

        yield return new object[]
        {
            "constructed-generic-over-imported-argument",
            """
            @Marker(typeof(Box[int32]))
            class Target {
            }
            """,
            new[] { "HelperLib4073.Box`1@HelperLib4073[System.Int32@System.Private.CoreLib]" },
        };

        yield return new object[]
        {
            "scalar-imported-type",
            """
            @Marker(typeof(string))
            class Target {
            }
            """,
            new[] { "System.String@System.Private.CoreLib" },
        };

        yield return new object[]
        {
            "array-of-imported-scalars",
            """
            @Many([]Type{typeof(int32), typeof(string)})
            class Target {
            }
            """,
            new[] { "System.Int32@System.Private.CoreLib", "System.String@System.Private.CoreLib" },
        };
    }

    /// <summary>
    /// Every spelling compiles, IL-verifies, and reifies to the type the source
    /// names. The assertion is on the exact ORDERED list of reified arguments —
    /// positional then named, array elements flattened — so a dropped attribute
    /// (which is how the <c>Type[]</c>-of-source-scalars row failed) is an empty
    /// list rather than a silent pass.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="declaration">The annotated G# declaration.</param>
    /// <param name="expected">The expected reified arguments, in order.</param>
    [Theory]
    [MemberData(nameof(TypeArguments))]
    public void AnAttributeTypeArgument_ReifiesToTheTypeTheSourceNames(
        string name,
        string declaration,
        string[] expected)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4073_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            // The emitted assembly's identity is the PACKAGE name, so the file
            // must be named for it or nothing can resolve `P` when the blob's
            // assembly-qualified names are decoded.
            var appPath = Path.Combine(tempDir, "P.dll");
            var source = Preamble + declaration + "\n\nConsole.WriteLine(\"ok\")\n";
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.Empty(ErrorIds(appLog));
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var reified = ReifiedAttributeArguments(appPath, libPath, "Target");
            Assert.Equal(expected, reified);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The issue's own program, end to end: a generic attribute whose type
    /// parameter is constrained <c>where TEnum : struct, Enum</c> is
    /// materialised by reflection at run time. Before the fix this threw
    /// <c>ArgumentException: GenericArguments[0], 'System.Int32', … violates the
    /// constraint of type parameter 'TEnum'</c> — the exact symptom the
    /// self-migration gate reported. Kept beside the metadata rows because a
    /// reified-metadata assertion alone would not prove the CLR accepts the
    /// instantiation.
    /// </summary>
    [Fact]
    public void AConstrainedGenericAttributeArgumentMaterialisesAtRunTime()
    {
        const string Declaration = """
            @Marker(typeof(Constrained[Status]))
            class Target {
            }
            """;

        const string Body = """

            Console.WriteLine(Probe.DescribeMarker(typeof(Target)))
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4073_run_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var source = Preamble + Declaration + "\n" + Body + "\n";
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.Empty(ErrorIds(appLog));
            Assert.True(File.Exists(appPath), $"the sample must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath, libPath);
            Assert.True(exit == 0, $"the sample must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(new[] { "P.Status" }, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Review feedback on PR #4087. The widened-container arm this fix added is
    /// an applicability rule, so it decides which constructor the emitter
    /// SELECTS. Matching on the container alone made every <c>object[]</c>
    /// covariant by its current element VALUES, and
    /// <c>@Names([]object{"x"})</c> — whose source array type is
    /// <c>object[]</c> — satisfied a <c>string[]</c> constructor the author
    /// could not have called. The arm must fire for the container the compiler
    /// itself widened and for nothing else, so all three shapes are asserted
    /// together: the widened one is encoded, and neither of the source-illegal
    /// ones is.
    /// </summary>
    /// <remarks>
    /// <para>The two rejected shapes used to be dropped SILENTLY, with no
    /// diagnostic — the pre-existing behaviour of an attribute matching no
    /// constructor, and the reason this issue's own <c>Type[]</c> half went
    /// unnoticed. That was filed as issue #4097 and this test asserted the drop
    /// with a note saying the rows would become diagnostics when #4097 landed.
    /// It has: they now report GS0583, and
    /// <see cref="Issue4097AttributeConstructorNotFoundTests"/> owns the
    /// diagnostic's own coverage.</para>
    /// <para>The rejected rows moved into compilations of their own because the
    /// GS0583 channel is emit-time and aborts on the first offending attribute,
    /// so one source file can no longer carry an accepted row and a rejected
    /// one at once. What this test asserts is unchanged in substance: the arm
    /// fires for the container the compiler itself widened and for nothing
    /// else.</para>
    /// </remarks>
    [Fact]
    public void OnlyTheWidenedTypeArrayContainerSatisfiesAnArrayConstructor()
    {
        const string Accepted = """
            @Names([]string{"x"})
            class Faithful {
            }

            @Many([]Type{typeof(Status)})
            class WidenedTypes {
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4073_ctor_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var source = Preamble + Accepted + "\n\nConsole.WriteLine(\"ok\")\n";
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.Empty(ErrorIds(appLog));
            Assert.True(File.Exists(appPath), $"the sample must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            // A source `[]string` at a `string[]` parameter: always matched, and
            // must keep matching.
            Assert.Equal(new[] { "NamesAttribute" }, HelperAttributeNames(appPath, libPath, "Faithful"));

            // The container #3684 widened, at the parameter it was widened FOR.
            Assert.Equal(new[] { "ManyAttribute" }, HelperAttributeNames(appPath, libPath, "WidenedTypes"));
            Assert.Equal(
                new[] { "P.Status@P" },
                ReifiedAttributeArguments(appPath, libPath, "WidenedTypes"));

            // Source-illegal: the declared element type is `object`, not the
            // parameter's. Neither may be encoded — and, since #4097, neither
            // may be waved through in silence.
            foreach (var rejected in new[]
            {
                "@Names([]object{\"x\"})\nclass WidenedStrings {\n}",
                "@Many([]object{typeof(Status)})\nclass ObjectTypes {\n}",
            })
            {
                var rejectedPath = Path.Combine(tempDir, "Rejected.dll");
                var rejectedLog = Compile(
                    tempDir,
                    "Rejected.gs",
                    Preamble + rejected + "\n\nConsole.WriteLine(\"ok\")\n",
                    rejectedPath,
                    "/target:exe",
                    "/reference:" + libPath);

                Assert.Contains("GS0583", ErrorIds(rejectedLog));
            }
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Names the attributes from the helper library that were actually emitted
    /// onto one type. Distinguishes "encoded" from "dropped", which the reified
    /// ARGUMENT list cannot: an attribute with no <c>Type</c> argument and an
    /// attribute that was never written both describe as an empty list.
    /// </summary>
    /// <param name="assemblyPath">The emitted assembly.</param>
    /// <param name="libPath">The referenced helper library.</param>
    /// <param name="typeName">The annotated type's simple name.</param>
    /// <returns>The helper attribute type names, in metadata order.</returns>
    private static string[] HelperAttributeNames(string assemblyPath, string libPath, string typeName)
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
                attribute.AttributeType.Namespace?.StartsWith("HelperLib4073", StringComparison.Ordinal) == true)
            .Select(attribute => attribute.AttributeType.Name)
            .ToArray();
    }

    private static string[] ErrorIds(string log)
        => Regex.Matches(log, @"error (GS[0-9]{4})")
            .Select(match => match.Groups[1].Value)
            .ToArray();

    /// <summary>
    /// Loads the emitted assembly in a <see cref="MetadataLoadContext"/> and
    /// returns a structural description of every <c>System.Type</c> argument on
    /// the attributes of <paramref name="typeName"/> — positional first, then
    /// named, with array arguments flattened in element order. Decoding through
    /// the metadata reader is what makes this an assertion about the emitted
    /// TypeSpec: an argument whose serialised name does not resolve throws here
    /// rather than reading back as something plausible.
    /// </summary>
    /// <param name="assemblyPath">The emitted assembly.</param>
    /// <param name="libPath">The referenced helper library.</param>
    /// <param name="typeName">The annotated type's simple name.</param>
    /// <returns>The reified argument descriptions, in order.</returns>
    private static string[] ReifiedAttributeArguments(string assemblyPath, string libPath, string typeName)
    {
        var paths = new List<string>(TrustedPlatformAssemblies())
        {
            assemblyPath,
            libPath,
        };

        using var context = new MetadataLoadContext(new PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)));
        var assembly = context.LoadFromAssemblyPath(assemblyPath);
        var target = assembly.GetTypes().Single(candidate => candidate.Name == typeName);

        var described = new List<string>();
        foreach (var attribute in target.GetCustomAttributesData())
        {
            if (!attribute.AttributeType.Namespace?.StartsWith("HelperLib4073", StringComparison.Ordinal) ?? true)
            {
                continue;
            }

            foreach (var argument in attribute.ConstructorArguments)
            {
                Flatten(argument, described);
            }

            foreach (var named in attribute.NamedArguments)
            {
                Flatten(named.TypedValue, described);
            }
        }

        return described.ToArray();

        static void Flatten(CustomAttributeTypedArgument argument, List<string> into)
        {
            if (argument.Value is IReadOnlyCollection<CustomAttributeTypedArgument> elements)
            {
                foreach (var element in elements)
                {
                    Flatten(element, into);
                }

                return;
            }

            if (argument.Value is Type type)
            {
                into.Add(Describe(type));
            }
        }
    }

    /// <summary>
    /// Describes a reified type structurally: a constructed generic reads as
    /// <c>Definition@DefinitionAssembly[Argument@ArgumentAssembly, …]</c>,
    /// an array appends <c>[]</c>, and a leaf is its full name plus the SIMPLE
    /// name of the assembly that declares it. Version and public key are
    /// deliberately left out — they are not what this issue is about — but the
    /// declaring assembly is not, because the whole defect was an argument
    /// coming from the wrong one.
    /// </summary>
    /// <param name="type">The reified type.</param>
    /// <returns>The structural description.</returns>
    private static string Describe(Type type)
    {
        if (type.IsArray)
        {
            return Describe(type.GetElementType()!) + "[]";
        }

        if (type.IsConstructedGenericType)
        {
            var definition = type.GetGenericTypeDefinition();
            var arguments = type.GetGenericArguments().Select(Describe);
            return Describe(definition) + "[" + string.Join(",", arguments) + "]";
        }

        return (type.FullName ?? type.Name) + "@" + type.Assembly.GetName().Name;
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "HelperLib4073",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib4073.dll");
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

    private static (int Exit, string Output) RunDotnet(string assemblyPath, string libPath)
    {
        var dir = Path.GetDirectoryName(assemblyPath) ?? ".";
        var sideBySide = Path.Combine(dir, Path.GetFileName(libPath));
        if (!File.Exists(sideBySide))
        {
            File.Copy(libPath, sideBySide);
        }

        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = dir,
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
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
