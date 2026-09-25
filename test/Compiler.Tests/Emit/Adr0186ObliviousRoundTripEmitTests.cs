// <copyright file="Adr0186ObliviousRoundTripEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GscProgram = GSharp.Compiler.Program;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0186 §8, step 5: the metadata round-trip becomes three-valued and
/// total — <b>non-null stays non-null, nullable stays nullable, oblivious
/// stays oblivious</b>. Under ADR-0136 the third case was not expressible:
/// there was no way to declare a G# position oblivious, so nothing could be
/// emitted as one.
/// <para>
/// Each case compiles G# through the real command line, re-reads the emitted
/// assembly through the same <see cref="MetadataLoadContext"/> path
/// <see cref="ClrNullability"/> uses at bind time, and asserts the type each
/// position re-imports as. <see cref="Issue1354NullabilityRoundTripEmitTests"/>
/// keeps pinning the two values ADR-0136 already guaranteed; the cases here
/// put all three side by side in one type, so a regression that moved an
/// oblivious position onto either neighbour — or either neighbour onto it —
/// is caught in the same assertion.
/// </para>
/// <para>
/// <b>Emit shape.</b> §8 allows two: emit nothing (csc's shape for a wholly
/// <c>#nullable disable</c> type), or explicit byte <c>0</c>. gsc emits the
/// explicit byte, and must: it stamps <c>[NullableContext(1)]</c> on every type
/// it emits, so "nothing" on a member inside such a type would read back
/// through the context walk as <em>non-null</em> — the laundering ADR-0186
/// exists to end. Explicit <c>0</c> inside a <c>[NullableContext(1)]</c> type is
/// also how csc writes a <c>#nullable disable</c> member of a type whose other
/// members are enabled (csc picks each type's context byte by majority, so its
/// exact rows vary with the member mix); what both compilers' metadata
/// <em>says</em> is compared against Roslyn's actual output by
/// <see cref="Csc_And_Gsc_Agree_On_Every_Oblivious_Position"/>.
/// </para>
/// </summary>
public class Adr0186ObliviousRoundTripEmitTests
{
    private const string MixedSource = """
        package Probe
        import System
        import System.Collections.Generic

        delegate Mapper[T](x T) T;

        class Holder {
            var NonNullField string = ""
            var MaybeField string?
            @Oblivious var ObliviousSequence sequence[List[string]?]
            @Oblivious var ObliviousMapper Mapper[string?]
            @Oblivious var ObliviousField string
            @Oblivious var ObliviousList List[string]
            @Oblivious var ObliviousStatedElements List[string?]
            prop NonNullProp string { get; set }
            prop MaybeProp string? { get; set }
            @Oblivious prop ObliviousProp string { get; set }
            @Oblivious func ObliviousMethod(p string) string { return p }
            func MixedMethod(@Oblivious oblivious string, maybe string?, nonNull string) string { return nonNull }
            @Oblivious var ObliviousMap map[string?, string]
            var EnabledMap map[string?, string] = map[string?, string]{}
            @Oblivious event ObliviousEvent Action[string]
            event MaybeArgsEvent Action[string?]
            event PlainEvent Action[string]
        }
        """;

    /// <summary>
    /// The three values, side by side in one enabled type, on fields and
    /// properties.
    /// </summary>
    [Fact]
    public void Fields_And_Properties_Round_Trip_All_Three_Values()
    {
        WithCompiledType(MixedSource, "Probe.Holder", Array.Empty<string>(), holder =>
        {
            Assert.Same(TypeSymbol.String, ClrNullability.GetFieldTypeSymbol(holder.GetField("NonNullField")!));
            AssertNullableString(ClrNullability.GetFieldTypeSymbol(holder.GetField("MaybeField")!));
            AssertPlatformString(ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousField")!));

            Assert.Same(TypeSymbol.String, ClrNullability.GetPropertyTypeSymbol(holder.GetProperty("NonNullProp")!));
            AssertNullableString(ClrNullability.GetPropertyTypeSymbol(holder.GetProperty("MaybeProp")!));
            AssertPlatformString(ClrNullability.GetPropertyTypeSymbol(holder.GetProperty("ObliviousProp")!));
        });
    }

    /// <summary>
    /// Nested positions round-trip as written. An oblivious scope makes only
    /// the top level of a slot's type platform (the owner's 2026-09-25
    /// amendment to open question 12), so an oblivious <c>List[string]</c> is
    /// <c>List[string]!</c> on the way out and on the way back, and a stated
    /// <c>?</c> inside it survives as <c>T?</c>.
    /// </summary>
    [Fact]
    public void Nested_Positions_Round_Trip()
    {
        WithCompiledType(MixedSource, "Probe.Holder", Array.Empty<string>(), holder =>
        {
            var list = Assert.IsType<PlatformTypeSymbol>(ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousList")!));
            Assert.Same(TypeSymbol.String, TypeArgumentAt(list.UnderlyingType, 0));

            var stated = Assert.IsType<PlatformTypeSymbol>(ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousStatedElements")!));
            AssertNullableString(TypeArgumentAt(stated.UnderlyingType, 0));
        });
    }

    /// <summary>
    /// G#'s own structural types round-trip their nested positions too
    /// (found in review, PR #4357): a <c>map[string?, string]</c> used to be
    /// written from its erased CLR shape, so its flags said <c>1,1,1</c> —
    /// losing the stated <c>?</c> even in an enabled declaration, and unable
    /// to say <c>0</c> for an oblivious one's top level. The value is nested,
    /// so in an oblivious declaration it is what it spells.
    /// </summary>
    [Fact]
    public void Map_Positions_Round_Trip()
    {
        WithCompiledType(MixedSource, "Probe.Holder", Array.Empty<string>(), holder =>
        {
            var oblivious = Assert.IsType<PlatformTypeSymbol>(ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousMap")!));
            AssertNullableString(TypeArgumentAt(oblivious.UnderlyingType, 0));
            Assert.Same(TypeSymbol.String, TypeArgumentAt(oblivious.UnderlyingType, 1));

            var enabled = ClrNullability.GetFieldTypeSymbol(holder.GetField("EnabledMap")!);
            Assert.IsNotType<PlatformTypeSymbol>(enabled);
            AssertNullableString(TypeArgumentAt(enabled, 0));
            Assert.Same(TypeSymbol.String, TypeArgumentAt(enabled, 1));
        });
    }

    /// <summary>
    /// The other G# structural shapes an oblivious scope now reaches, each
    /// mixing a stated <c>?</c> with a platform top level: a
    /// <c>sequence[List[string]?]</c> (element stated nullable, its own
    /// argument as written) and a constructed source delegate
    /// <c>Mapper[string?]</c>. Before the flags builder walked their symbolic
    /// arguments, both were written from the erased CLR shape.
    /// </summary>
    [Fact]
    public void Sequence_And_Source_Delegate_Positions_Round_Trip()
    {
        WithCompiledType(MixedSource, "Probe.Holder", Array.Empty<string>(), holder =>
        {
            var sequence = Assert.IsType<PlatformTypeSymbol>(ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousSequence")!));
            var element = Assert.IsType<NullableTypeSymbol>(TypeArgumentAt(sequence.UnderlyingType, 0));
            Assert.Same(TypeSymbol.String, TypeArgumentAt(element.UnderlyingType, 0));

            var mapper = Assert.IsType<PlatformTypeSymbol>(ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousMapper")!));
            AssertNullableString(TypeArgumentAt(mapper.UnderlyingType, 0));
        });
    }

    /// <summary>
    /// Parameters and returns: a wholly oblivious method, and a method mixing
    /// all three values across its parameters (a parameter-level
    /// <c>@Oblivious</c>).
    /// </summary>
    [Fact]
    public void Parameters_And_Returns_Round_Trip_All_Three_Values()
    {
        WithCompiledType(MixedSource, "Probe.Holder", Array.Empty<string>(), holder =>
        {
            var oblivious = holder.GetMethod("ObliviousMethod")!;
            AssertPlatformString(ClrNullability.GetParameterTypeSymbol(oblivious.GetParameters()[0]));
            AssertPlatformString(ClrNullability.GetReturnTypeSymbol(oblivious));

            var mixed = holder.GetMethod("MixedMethod")!;
            var parameters = mixed.GetParameters();
            AssertPlatformString(ClrNullability.GetParameterTypeSymbol(parameters[0]));
            AssertNullableString(ClrNullability.GetParameterTypeSymbol(parameters[1]));
            Assert.Same(TypeSymbol.String, ClrNullability.GetParameterTypeSymbol(parameters[2]));
            Assert.Same(TypeSymbol.String, ClrNullability.GetReturnTypeSymbol(mixed));
        });
    }

    /// <summary>
    /// Events. The import side reads an event's handler nullability off the
    /// Event row (<c>MemberLookup.GetClrEventHandlerTypeSymbol</c>), which is
    /// where csc writes it; step 5 made gsc write it there too. Before that,
    /// every gsc event re-imported through the type-level
    /// <c>[NullableContext(1)]</c> as wholly non-null — so this pins both an
    /// oblivious handler and the enabled <c>Action[string?]</c> case the same
    /// gap had been flattening since ADR-0136.
    /// </summary>
    [Fact]
    public void Events_Round_Trip_Their_Handler_Nullability()
    {
        WithCompiledType(MixedSource, "Probe.Holder", Array.Empty<string>(), holder =>
        {
            // The handler is the slot's top level, so it is platform; its type
            // argument is nested and reads as written.
            var oblivious = Assert.IsType<PlatformTypeSymbol>(
                GSharp.Core.CodeAnalysis.Binding.MemberLookup.GetClrEventHandlerTypeSymbol(holder.GetEvent("ObliviousEvent")!));
            Assert.Same(TypeSymbol.String, FirstTypeArgument(oblivious.UnderlyingType));

            var maybe = GSharp.Core.CodeAnalysis.Binding.MemberLookup.GetClrEventHandlerTypeSymbol(holder.GetEvent("MaybeArgsEvent")!);
            Assert.IsNotType<PlatformTypeSymbol>(maybe);
            AssertNullableString(FirstTypeArgument(maybe));

            var plain = GSharp.Core.CodeAnalysis.Binding.MemberLookup.GetClrEventHandlerTypeSymbol(holder.GetEvent("PlainEvent")!);
            Assert.IsNotType<PlatformTypeSymbol>(plain);
            Assert.Same(TypeSymbol.String, FirstTypeArgument(plain));
        });
    }

    /// <summary>
    /// The emit shape §8 sanctions: explicit oblivious bytes. The top level of
    /// an oblivious position is <c>0</c> — never <c>1</c>, which would launder
    /// "nobody said" into a non-null guarantee in metadata. A nested position
    /// states what it spells, so an oblivious <c>List[string]</c> is written
    /// <c>{0, 1}</c>. A method
    /// whose positions are all oblivious carries <c>[NullableContext(0)]</c>,
    /// exactly the attribute csc puts on a <c>#nullable disable</c> method of
    /// an enabled type.
    /// </summary>
    [Fact]
    public void Oblivious_Positions_Are_Emitted_As_Explicit_Zero_Bytes()
    {
        WithCompiledType(MixedSource, "Probe.Holder", Array.Empty<string>(), holder =>
        {
            AssertAllZero(NullableBytes(holder.GetField("ObliviousField")!.GetCustomAttributesData()));
            Assert.Equal(new byte[] { 0, 1 }, NullableBytes(holder.GetField("ObliviousList")!.GetCustomAttributesData()));
            AssertAllZero(NullableBytes(holder.GetProperty("ObliviousProp")!.GetCustomAttributesData()));
            Assert.Equal((byte)0, ContextByte(holder.GetMethod("ObliviousMethod")!.GetCustomAttributesData()));

            // The enabled neighbours keep ADR-0136's shape byte for byte: no
            // per-position attribute on a non-null member (the type-level
            // `[NullableContext(1)]` covers it), `2` on a nullable one.
            Assert.Null(NullableBytes(holder.GetField("NonNullField")!.GetCustomAttributesData()));
            Assert.Equal(new byte[] { 2 }, NullableBytes(holder.GetField("MaybeField")!.GetCustomAttributesData()));
            Assert.Equal((byte)1, ContextByte(holder.GetCustomAttributesData()));
        });
    }

    /// <summary>
    /// The compilation level: <c>--nullability=oblivious</c> with no annotation
    /// anywhere, and <c>@NullabilityEnabled</c> opting one declaration back
    /// out — declaration level wins, and it wins on the way back in too.
    /// </summary>
    [Fact]
    public void An_Oblivious_Compilation_Round_Trips_With_Its_Enabled_Exceptions()
    {
        const string source = """
            package Probe

            class Holder {
                var Field string
                var Maybe string?
                @NullabilityEnabled var Enabled string = ""
                func Method(p string) string { return p }
                @NullabilityEnabled func EnabledMethod(p string) string { return p }
            }
            """;

        WithCompiledType(source, "Probe.Holder", new[] { "/nullability:oblivious" }, holder =>
        {
            AssertPlatformString(ClrNullability.GetFieldTypeSymbol(holder.GetField("Field")!));
            AssertNullableString(ClrNullability.GetFieldTypeSymbol(holder.GetField("Maybe")!));
            Assert.Same(TypeSymbol.String, ClrNullability.GetFieldTypeSymbol(holder.GetField("Enabled")!));

            var method = holder.GetMethod("Method")!;
            AssertPlatformString(ClrNullability.GetParameterTypeSymbol(method.GetParameters()[0]));
            AssertPlatformString(ClrNullability.GetReturnTypeSymbol(method));

            var enabled = holder.GetMethod("EnabledMethod")!;
            Assert.Same(TypeSymbol.String, ClrNullability.GetParameterTypeSymbol(enabled.GetParameters()[0]));
            Assert.Same(TypeSymbol.String, ClrNullability.GetReturnTypeSymbol(enabled));
        });
    }

    /// <summary>
    /// §8's "validated against csc for free", made concrete. The same
    /// declarations are compiled by Roslyn with <c>#nullable disable</c>
    /// regions inside an enabled type and by gsc with <c>@Oblivious</c>, and
    /// every top-level position must re-import identically from both.
    /// <para>
    /// Nested positions deliberately differ. csc writes a
    /// <c>#nullable disable</c> <c>List&lt;string&gt;</c> as <c>{0, 0}</c>
    /// (<c>List[string!]!</c>), while an oblivious G# <c>List[string]</c> is
    /// <c>List[string]!</c> (<c>{0, 1}</c>). That is the owner's 2026-09-25
    /// amendment to open question 12. G# states the element as written, which
    /// is what cs2gs output already said before the scope existed.
    /// </para>
    /// </summary>
    [Fact]
    public void Csc_And_Gsc_Agree_On_Every_Oblivious_Position()
    {
        const string csharp = """
            #nullable enable
            namespace Probe
            {
                public class Holder
                {
                    public string NonNullField = "";
                    public string? MaybeField;
            #nullable disable
                    public string ObliviousField;
                    public System.Collections.Generic.List<string> ObliviousList;
                    public string ObliviousProp { get; set; }
                    public string ObliviousMethod(string p) => p;
            #nullable enable
                }
            }
            """;

        const string gsharp = """
            package Probe
            import System.Collections.Generic

            class Holder {
                var NonNullField string = ""
                var MaybeField string?
                @Oblivious var ObliviousField string
                @Oblivious var ObliviousList List[string]
                @Oblivious prop ObliviousProp string { get; set }
                @Oblivious func ObliviousMethod(p string) string { return p }
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_adr0186_csc_").FullName;
        try
        {
            var cscPath = CompileCSharp(tempDir, csharp);
            var gscPath = CompileGSharp(tempDir, gsharp, Array.Empty<string>());

            using var cscContext = LoadContext(cscPath);
            using var gscContext = LoadContext(gscPath);
            var csc = cscContext.LoadFromAssemblyPath(cscPath).GetType("Probe.Holder")!;
            var gsc = gscContext.LoadFromAssemblyPath(gscPath).GetType("Probe.Holder")!;

            foreach (var name in new[] { "NonNullField", "MaybeField", "ObliviousField" })
            {
                Assert.Equal(
                    ClrNullability.GetFieldTypeSymbol(csc.GetField(name)!).ToString(),
                    ClrNullability.GetFieldTypeSymbol(gsc.GetField(name)!).ToString());
            }

            Assert.Equal(
                ClrNullability.GetPropertyTypeSymbol(csc.GetProperty("ObliviousProp")!).ToString(),
                ClrNullability.GetPropertyTypeSymbol(gsc.GetProperty("ObliviousProp")!).ToString());

            var cscMethod = csc.GetMethod("ObliviousMethod")!;
            var gscMethod = gsc.GetMethod("ObliviousMethod")!;
            Assert.Equal(
                ClrNullability.GetParameterTypeSymbol(cscMethod.GetParameters()[0]).ToString(),
                ClrNullability.GetParameterTypeSymbol(gscMethod.GetParameters()[0]).ToString());
            Assert.Equal(
                ClrNullability.GetReturnTypeSymbol(cscMethod).ToString(),
                ClrNullability.GetReturnTypeSymbol(gscMethod).ToString());

            // And the agreement is on the oblivious answer, not merely on
            // some shared answer.
            AssertPlatformString(ClrNullability.GetFieldTypeSymbol(gsc.GetField("ObliviousField")!));
            AssertPlatformString(ClrNullability.GetReturnTypeSymbol(gscMethod));

            // The one deliberate difference: the container's top level agrees
            // (platform), its element does not (see the summary).
            Assert.Equal("System.Collections.Generic.List[string!]!", ClrNullability.GetFieldTypeSymbol(csc.GetField("ObliviousList")!).ToString());
            Assert.Equal("System.Collections.Generic.List[string]!", ClrNullability.GetFieldTypeSymbol(gsc.GetField("ObliviousList")!).ToString());

            // gsc's own bytes for those positions are all `0`. csc's raw shape
            // is not compared byte for byte: it chooses each type's
            // `[NullableContext]` by majority over the members, so which
            // members carry an explicit attribute at all depends on the mix.
            // What both must agree on is what the metadata SAYS, asserted above.
            AssertAllZero(NullableBytes(gsc.GetField("ObliviousField")!.GetCustomAttributesData()));
            Assert.Equal(new byte[] { 0, 1 }, NullableBytes(gsc.GetField("ObliviousList")!.GetCustomAttributesData()));

            Assert.Equal((byte)0, ContextByte(gscMethod.GetCustomAttributesData()));
        }
        finally
        {
            TryDelete(tempDir);
        }
    }

    private static TypeSymbol FirstTypeArgument(TypeSymbol type) => TypeArgumentAt(type, 0);

    private static TypeSymbol TypeArgumentAt(TypeSymbol type, int index) => type switch
    {
        NullabilityAnnotatedTypeSymbol annotated => annotated.GetTypeArgumentSymbol(index),

        // A constructed CLR type whose arguments say nothing beyond their CLR
        // types is kept erased, with no symbolic argument list.
        ImportedTypeSymbol { TypeArguments.Length: 0, ClrType: { IsGenericType: true } clr } =>
            TypeSymbol.FromClrType(clr.GetGenericArguments()[index]),
        ImportedTypeSymbol imported => imported.TypeArguments[index],
        MapTypeSymbol map => index == 0 ? map.KeyType : map.ValueType,
        _ => throw new InvalidOperationException($"'{type}' ({type.GetType().Name}) carries no type arguments."),
    };

    private static void AssertPlatformString(TypeSymbol symbol)
    {
        var platform = Assert.IsType<PlatformTypeSymbol>(symbol);
        Assert.Same(TypeSymbol.String, platform.UnderlyingType);
    }

    private static void AssertNullableString(TypeSymbol symbol)
    {
        var nullable = Assert.IsType<NullableTypeSymbol>(symbol);
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType);
    }

    private static void AssertAllZero(byte[] bytes)
    {
        Assert.NotNull(bytes);
        Assert.NotEmpty(bytes);
        Assert.All(bytes, b => Assert.Equal((byte)0, b));
    }

    private static byte[] NullableBytes(IEnumerable<CustomAttributeData> attributes)
    {
        var attribute = attributes.FirstOrDefault(a =>
            a.AttributeType.FullName == "System.Runtime.CompilerServices.NullableAttribute");
        if (attribute == null)
        {
            return null;
        }

        var argument = attribute.ConstructorArguments[0];
        return argument.Value is byte scalar
            ? new[] { scalar }
            : ((IEnumerable<CustomAttributeTypedArgument>)argument.Value!).Select(a => (byte)a.Value!).ToArray();
    }

    private static byte? ContextByte(IEnumerable<CustomAttributeData> attributes)
    {
        var attribute = attributes.FirstOrDefault(a =>
            a.AttributeType.FullName == "System.Runtime.CompilerServices.NullableContextAttribute");
        return attribute?.ConstructorArguments[0].Value as byte?;
    }

    private static void WithCompiledType(string source, string typeName, string[] extraArguments, Action<Type> assert)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_adr0186_roundtrip_").FullName;
        try
        {
            var dllPath = CompileGSharp(tempDir, source, extraArguments);
            using var context = LoadContext(dllPath);
            var type = context.LoadFromAssemblyPath(dllPath).GetType(typeName)
                ?? throw new InvalidOperationException($"{typeName} not found in emitted assembly.");
            assert(type);
        }
        finally
        {
            TryDelete(tempDir);
        }
    }

    private static MetadataLoadContext LoadContext(string assemblyPath)
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var resolver = new PathAssemblyResolver(
            Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { assemblyPath }));
        return new MetadataLoadContext(resolver, "System.Private.CoreLib");
    }

    private static string CompileGSharp(string tempDir, string source, string[] extraArguments)
    {
        var srcPath = Path.Combine(tempDir, "probe.gs");
        var outPath = Path.Combine(tempDir, "probe.dll");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
        };
        args.AddRange(extraArguments);
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
            exit = GscProgram.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(exit == 0, $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileCSharp(string tempDir, string source)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "CscProbe",
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var path = Path.Combine(tempDir, "CscProbe.dll");
        var result = compilation.Emit(path);
        Assert.True(
            result.Success,
            string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return path;
    }

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
            // Best-effort cleanup.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
