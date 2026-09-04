// <copyright file="Issue3892EnumAttributeCtorSignatureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3892: an attribute constructor taking an ENUM emitted a
/// <c>MemberRef</c> whose signature named the enum's UNDERLYING type, so
/// <c>[AttributeUsage(AttributeTargets.Class)]</c> encoded as
/// <c>AttributeUsageAttribute..ctor(Int32)</c> — a constructor that does not
/// exist. The assembly loaded, but the moment reflection touched the attribute
/// (which is exactly what xunit discovery does when it enumerates types) the
/// runtime threw <c>MissingMethodException</c>, surfacing as the
/// <c>NO-TESTS-RAN</c> parity failure on migrated <c>test/Core.Tests</c>.
/// <para>
/// The cause was applying ECMA-335 II.23.3 — which says the enum-typed *value*
/// in a custom-attribute blob is serialised as its underlying type, and which
/// remains correct in <c>WriteCustomAttributeFixedArg</c> — to the method
/// SIGNATURE as well. II.23.2.12 requires the signature parameter to be
/// <c>ELEMENT_TYPE_VALUETYPE</c> followed by a TypeDefOrRef coded index naming
/// the enum itself.
/// </para>
/// <para>
/// The defect is general to any attribute constructor parameter of enum type,
/// not specific to <c>AttributeUsageAttribute</c>; both are covered below, as
/// is the anti-vacuity case that a genuinely <see cref="int"/>-typed parameter
/// must still encode as <c>ELEMENT_TYPE_I4</c>.
/// </para>
/// </summary>
public class Issue3892EnumAttributeCtorSignatureTests
{
    private const byte ElementTypeVoid = 0x01;
    private const byte ElementTypeI4 = 0x08;
    private const byte ElementTypeValueType = 0x11;

    /// <summary>
    /// Decodes the single positional parameter of a <c>.ctor</c> MemberRef
    /// signature, returning its leading element-type byte and — for a
    /// VALUETYPE/CLASS parameter — the simple name of the type it references.
    /// </summary>
    private static (byte ElementType, string TypeName) DecodeSingleCtorParameter(
        MetadataReader md,
        MemberReferenceHandle ctorHandle)
    {
        var reader = md.GetBlobReader(md.GetMemberReference(ctorHandle).Signature);

        var header = reader.ReadSignatureHeader();
        Assert.True(header.IsInstance, "an attribute .ctor signature is HASTHIS");

        var parameterCount = reader.ReadCompressedInteger();
        Assert.Equal(1, parameterCount);

        Assert.Equal(ElementTypeVoid, reader.ReadByte());

        var elementType = reader.ReadByte();
        if (elementType is ElementTypeValueType or 0x12 /* CLASS */)
        {
            var typeHandle = reader.ReadTypeHandle();
            var name = typeHandle.Kind switch
            {
                HandleKind.TypeReference => md.GetString(md.GetTypeReference((TypeReferenceHandle)typeHandle).Name),
                HandleKind.TypeDefinition => md.GetString(md.GetTypeDefinition((TypeDefinitionHandle)typeHandle).Name),
                _ => string.Empty,
            };
            return (elementType, name);
        }

        return (elementType, string.Empty);
    }

    private static CustomAttribute FindAttributeByCtorParentName(
        MetadataReader md,
        TypeDefinition owner,
        string attributeTypeName)
        => owner.GetCustomAttributes()
            .Select(md.GetCustomAttribute)
            .Single(a =>
            {
                if (a.Constructor.Kind != HandleKind.MemberReference)
                {
                    return false;
                }

                var cr = md.GetMemberReference((MemberReferenceHandle)a.Constructor);
                return cr.Parent.Kind == HandleKind.TypeReference
                    && md.GetString(md.GetTypeReference((TypeReferenceHandle)cr.Parent).Name) == attributeTypeName;
            });

    private static MemoryStream EmitOrThrow(Compilation compilation)
    {
        var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        peStream.Position = 0;
        return peStream;
    }

    private static Compilation CompileWithFixtures(string source)
    {
        var fixturePath = typeof(ImportedEnumCtorAttribute).Assembly.Location;
        var resolver = ReferenceResolver.WithReferences(new[] { fixturePath });
        return new Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)));
    }

    private static Compilation Compile(string source)
        => new Compilation(SyntaxTree.Parse(SourceText.From(source)));

    /// <summary>
    /// The reported instance: <c>[AttributeUsage(AttributeTargets.Class)]</c>.
    /// FAILS on origin/main — the parameter encodes as <c>ELEMENT_TYPE_I4</c>.
    /// </summary>
    [Fact]
    public void AttributeUsage_EnumParameter_EncodesAsEnumValueTypeRef_NotInt32()
    {
        const string Source = """
            package Issue3892Usage
            import System

            @AttributeUsage(AttributeTargets.Class)
            class MarkerAttribute : Attribute {
            }

            @Marker
            class Marked {
            }
            """;

        using var pe = EmitOrThrow(Compile(Source));
        using var peReader = new PEReader(pe, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();

        var markerDef = md.TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single(td => md.GetString(td.Name) == "MarkerAttribute");

        var usage = FindAttributeByCtorParentName(md, markerDef, "AttributeUsageAttribute");
        var (elementType, typeName) = DecodeSingleCtorParameter(
            md,
            (MemberReferenceHandle)usage.Constructor);

        Assert.Equal(ElementTypeValueType, elementType);
        Assert.Equal("AttributeTargets", typeName);
    }

    /// <summary>
    /// The load-time proof: enumerate the emitted assembly's exported types and
    /// materialise their attributes the way xunit discovery does. On
    /// origin/main this throws
    /// <c>MissingMethodException: AttributeUsageAttribute..ctor(Int32)</c>.
    /// ILVerify does NOT catch this (it resolves references by name and accepts
    /// the wrong element type — see #3764), so the assertion has to be a real
    /// load.
    /// </summary>
    [Fact]
    public void AttributeUsage_MarkedType_SurvivesReflectionDiscovery()
    {
        const string Source = """
            package Issue3892Discovery
            import System

            @AttributeUsage(AttributeTargets.Class)
            class MarkerAttribute : Attribute {
            }

            @Marker
            class Marked {
            }
            """;

        using var pe = EmitOrThrow(Compile(Source));

        var loadContext = new AssemblyLoadContext(
            nameof(AttributeUsage_MarkedType_SurvivesReflectionDiscovery),
            isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(pe);

            // GetExportedTypes() is the call xunit's discoverer makes first.
            var exported = asm.GetExportedTypes();
            var marker = Assert.Single(exported, t => t.Name == "MarkerAttribute");
            var marked = Assert.Single(exported, t => t.Name == "Marked");

            // Resolving [AttributeUsage] on the attribute type is what the
            // runtime does while materialising @Marker on `Marked`; with an
            // Int32-typed MemberRef this is the MissingMethodException site.
            var usage = marker.GetCustomAttribute<AttributeUsageAttribute>();
            Assert.NotNull(usage);
            Assert.Equal(AttributeTargets.Class, usage.ValidOn);

            var applied = marked.GetCustomAttributes(inherit: true);
            Assert.Contains(applied, a => a.GetType().Name == "MarkerAttribute");
        }
        finally
        {
            loadContext.Unload();
        }
    }

    /// <summary>
    /// Generality: the defect is not <c>AttributeUsage</c>-specific. Any
    /// attribute constructor with an enum-typed positional parameter was
    /// mis-encoded. FAILS on origin/main.
    /// </summary>
    [Fact]
    public void UserAttribute_EnumCtorParameter_EncodesAsEnumValueTypeRef_AndRoundTrips()
    {
        const string Source = """
            package Issue3892General
            import GSharp.Core.Tests.Fixtures

            @ImportedEnumCtor(ImportedAttributeMode.Warning)
            class Tagged {
            }
            """;

        using var pe = EmitOrThrow(CompileWithFixtures(Source));

        using (var peReader = new PEReader(pe, PEStreamOptions.LeaveOpen))
        {
            var md = peReader.GetMetadataReader();
            var taggedDef = md.TypeDefinitions
                .Select(md.GetTypeDefinition)
                .Single(td => md.GetString(td.Name) == "Tagged");

            var attr = FindAttributeByCtorParentName(md, taggedDef, "ImportedEnumCtorAttribute");
            var (elementType, typeName) = DecodeSingleCtorParameter(
                md,
                (MemberReferenceHandle)attr.Constructor);

            Assert.Equal(ElementTypeValueType, elementType);
            Assert.Equal("ImportedAttributeMode", typeName);
        }

        pe.Position = 0;
        var loadContext = new AssemblyLoadContext(
            nameof(UserAttribute_EnumCtorParameter_EncodesAsEnumValueTypeRef_AndRoundTrips),
            isCollectible: true);
        try
        {
            loadContext.Resolving += (ctx, name) =>
                name.Name == typeof(ImportedEnumCtorAttribute).Assembly.GetName().Name
                    ? typeof(ImportedEnumCtorAttribute).Assembly
                    : null;

            var asm = loadContext.LoadFromStream(pe);
            var tagged = Assert.Single(asm.GetExportedTypes(), t => t.Name == "Tagged");

            // Materialising the attribute instance (not just reading metadata)
            // is what actually invokes the referenced constructor.
            var instance = tagged.GetCustomAttributes(inherit: false)
                .OfType<ImportedEnumCtorAttribute>()
                .Single();
            Assert.Equal(ImportedAttributeMode.Warning, instance.Mode);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    /// <summary>
    /// Anti-vacuity: a constructor parameter that is genuinely <see cref="int"/>
    /// must STILL encode as <c>ELEMENT_TYPE_I4</c>. This test passes on
    /// origin/main and guards against "fixing" #3892 by encoding every
    /// integral parameter as a value-type reference.
    /// </summary>
    [Fact]
    public void UserAttribute_Int32CtorParameter_StillEncodesAsInt32()
    {
        const string Source = """
            package Issue3892AntiVacuity
            import GSharp.Core.Tests.Fixtures

            @ImportedInt32Ctor(42)
            class Tagged {
            }
            """;

        using var pe = EmitOrThrow(CompileWithFixtures(Source));

        using (var peReader = new PEReader(pe, PEStreamOptions.LeaveOpen))
        {
            var md = peReader.GetMetadataReader();
            var taggedDef = md.TypeDefinitions
                .Select(md.GetTypeDefinition)
                .Single(td => md.GetString(td.Name) == "Tagged");

            var attr = FindAttributeByCtorParentName(md, taggedDef, "ImportedInt32CtorAttribute");
            var (elementType, typeName) = DecodeSingleCtorParameter(
                md,
                (MemberReferenceHandle)attr.Constructor);

            Assert.Equal(ElementTypeI4, elementType);
            Assert.Equal(string.Empty, typeName);
        }

        pe.Position = 0;
        var loadContext = new AssemblyLoadContext(
            nameof(UserAttribute_Int32CtorParameter_StillEncodesAsInt32),
            isCollectible: true);
        try
        {
            loadContext.Resolving += (ctx, name) =>
                name.Name == typeof(ImportedInt32CtorAttribute).Assembly.GetName().Name
                    ? typeof(ImportedInt32CtorAttribute).Assembly
                    : null;

            var asm = loadContext.LoadFromStream(pe);
            var tagged = Assert.Single(asm.GetExportedTypes(), t => t.Name == "Tagged");
            var instance = tagged.GetCustomAttributes(inherit: false)
                .OfType<ImportedInt32CtorAttribute>()
                .Single();
            Assert.Equal(42, instance.Value);
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
