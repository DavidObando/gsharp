// <copyright file="ImportedEnumAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
/// Regression tests for issue #418 (P1-8): emitting a custom attribute whose
/// named-arg member is an enum defined in a referenced (non-BCL) assembly
/// must not lose the attribute. Such enum <see cref="System.Type"/> instances
/// are reified through a <see cref="System.Reflection.MetadataLoadContext"/>,
/// so the attribute-blob writer cannot call <see cref="System.Enum.GetUnderlyingType"/>
/// (which is runtime-Type only and throws <see cref="System.NotSupportedException"/>) —
/// it must instead read the <c>value__</c> instance field's type per
/// ECMA-335 II.14.3.
/// </summary>
public class ImportedEnumAttributeEmitTests
{
    private static ReferenceResolver FixtureResolver()
    {
        // Adding the test-assembly path forces every type from it to be
        // reified through a MetadataLoadContext when resolved by the compiler.
        var fixturePath = typeof(ImportedEnumArgAttribute).Assembly.Location;
        return ReferenceResolver.WithReferences(new[] { fixturePath });
    }

    private static Compilation CompileWithFixtures(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(FixtureResolver(), tree);
    }

    [Fact]
    public void Emit_Imported_Enum_NamedArg_Is_Written_To_Blob()
    {
        // Before the fix, ReflectionMetadataEmitter.WriteCustomAttributeFixedArg
        // called Enum.GetUnderlyingType on the MetadataLoadContext-resolved
        // enum and threw NotSupportedException; the surrounding try/catch
        // would drop the attribute, so the emitted Tagged type carried zero
        // custom attributes. After the fix the attribute (and its enum
        // named-arg value) must round-trip through the blob.
        var source = """
            package Demo
            import GSharp.Core.Tests.Fixtures

            @ImportedEnumArg(Mode = ImportedAttributeMode.Warning)
            class Tagged {
            }
            """;

        var compilation = CompileWithFixtures(source);

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();
        var taggedDef = md.TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single(td => md.GetString(td.Name) == "Tagged");

        // The Tagged type must carry exactly one custom attribute: our fixture.
        var attrHandle = Assert.Single(taggedDef.GetCustomAttributes());
        var attr = md.GetCustomAttribute(attrHandle);

        // The constructor reference must point at ImportedEnumArgAttribute..ctor.
        var ctorRef = md.GetMemberReference((MemberReferenceHandle)attr.Constructor);
        var attrTypeName = md.GetString(md.GetTypeReference((TypeReferenceHandle)ctorRef.Parent).Name);
        Assert.Equal("ImportedEnumArgAttribute", attrTypeName);

        // Sanity: the blob is non-empty (prolog + zero positional args +
        // one named arg payload).
        var blob = md.GetBlobBytes(attr.Value);
        Assert.NotEmpty(blob);
    }

    [Fact]
    public void Emit_Imported_Enum_NamedArg_Roundtrips_Through_Reflection()
    {
        // Stronger check: load the emitted PE and read the attribute via
        // System.Reflection.CustomAttributeData. The named-arg enum value
        // must round-trip with its correct underlying int value.
        var source = """
            package Demo
            import GSharp.Core.Tests.Fixtures

            @ImportedEnumArg(Mode = ImportedAttributeMode.Warning)
            class Tagged {
            }
            """;

        var compilation = CompileWithFixtures(source);

        using var peStream = new MemoryStream();
        var emit = compilation.Emit(peStream);
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;

        var loadContext = new AssemblyLoadContext(nameof(Emit_Imported_Enum_NamedArg_Roundtrips_Through_Reflection), isCollectible: true);
        try
        {
            // The emitted assembly references the fixture (test) assembly; the
            // loader needs to be told to reuse the test runtime's instance.
            loadContext.Resolving += (ctx, name) =>
            {
                if (name.Name == typeof(ImportedEnumArgAttribute).Assembly.GetName().Name)
                {
                    return typeof(ImportedEnumArgAttribute).Assembly;
                }

                return null;
            };

            var asm = loadContext.LoadFromStream(peStream);
            var tagged = asm.GetTypes().Single(t => t.Name == "Tagged");

            var cad = CustomAttributeData.GetCustomAttributes(tagged)
                .Single(c => c.AttributeType == typeof(ImportedEnumArgAttribute));

            Assert.Empty(cad.ConstructorArguments);

            var named = Assert.Single(cad.NamedArguments);
            Assert.Equal("Mode", named.MemberName);
            Assert.Equal(typeof(ImportedAttributeMode), named.TypedValue.ArgumentType);
            Assert.Equal(ImportedAttributeMode.Warning, (ImportedAttributeMode)named.TypedValue.Value!);
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
