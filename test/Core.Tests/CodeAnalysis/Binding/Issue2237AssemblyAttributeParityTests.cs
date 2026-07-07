// <copyright file="Issue2237AssemblyAttributeParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2237: file-level <c>@assembly:</c> annotations must reach parity
/// with C#'s <c>[assembly: ...]</c> — any attribute type the compiler can
/// resolve (BCL or a same-compilation user-declared attribute), not just
/// <c>InternalsVisibleTo</c>.
/// </summary>
public class Issue2237AssemblyAttributeParityTests
{
    [Fact]
    public void Binds_NonInternalsVisibleTo_Assembly_Annotation_Into_AssemblyAttributes()
    {
        var globalScope = BindSource(
            """
            package MyApp
            @assembly:System.Reflection.AssemblyMetadataAttribute("Key", "Value")

            func Main() {
            }
            """);

        Assert.Empty(GetBinderDiagnostics(globalScope));
        var attr = Assert.Single(globalScope.AssemblyAttributes);
        Assert.Equal("System.Reflection.AssemblyMetadataAttribute", attr.AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Assembly, attr.Target);
        Assert.Equal(2, attr.PositionalArguments.Length);
        Assert.Equal("Key", attr.PositionalArguments[0].Value);
        Assert.Equal("Value", attr.PositionalArguments[1].Value);
    }

    [Fact]
    public void InternalsVisibleTo_Annotation_Is_Excluded_From_AssemblyAttributes_But_Kept_In_FriendAssemblies()
    {
        // InternalsVisibleTo keeps its own early, syntactic fast path
        // (FriendAssemblies) so it isn't double-bound/double-emitted via the
        // general AssemblyAttributes list.
        var globalScope = BindSource(
            """
            package MyApp
            @assembly:InternalsVisibleTo("Some.Other.Assembly")
            @assembly:System.Reflection.AssemblyMetadataAttribute("Key", "Value")

            func Main() {
            }
            """);

        Assert.Empty(GetBinderDiagnostics(globalScope));
        Assert.Equal(new[] { "Some.Other.Assembly" }, globalScope.FriendAssemblies);
        var attr = Assert.Single(globalScope.AssemblyAttributes);
        Assert.Equal("System.Reflection.AssemblyMetadataAttribute", attr.AttributeType.Name);
    }

    [Fact]
    public void Reports_AttributeTypeNotFound_Instead_Of_The_Old_Fixed_GS0464_For_Unknown_Assembly_Attribute()
    {
        var globalScope = BindSource(
            """
            package MyApp
            @assembly:TotallyBogusAttribute("x")

            func Main() {
            }
            """);

        Assert.Contains(GetBinderDiagnostics(globalScope), d => d.Id == "GS0198");
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), d => d.Id == "GS0464");
        Assert.Empty(globalScope.AssemblyAttributes);
    }

    [Fact]
    public void Emits_Multiple_Arbitrary_Assembly_Attributes_As_Real_CustomAttribute_Rows()
    {
        const string source = """
            package MyApp
            @assembly:InternalsVisibleTo("Friend.Assembly")
            @assembly:System.Reflection.AssemblyFileVersionAttribute("1.3.1.0")
            @assembly:System.CodeDom.Compiler.GeneratedCodeAttribute("Nerdbank.GitVersioning.Tasks", "1.0")

            func Main() {
            }
            """;

        using var pe = Compile(source);
        var typeNames = GetAssemblyCustomAttributeTypeNames(pe);

        Assert.Contains("System.Runtime.CompilerServices.InternalsVisibleToAttribute", typeNames);
        Assert.Contains("System.Reflection.AssemblyFileVersionAttribute", typeNames);
        Assert.Contains("System.CodeDom.Compiler.GeneratedCodeAttribute", typeNames);
    }

    [Fact]
    public void Does_Not_Duplicate_AssemblyInformationalVersionAttribute_When_User_Declares_It_Explicitly()
    {
        // The emitter also synthesizes AssemblyInformationalVersionAttribute
        // from the /version:-style override when present; an explicit
        // user `@assembly:` declaration of the same (non-repeatable)
        // attribute type must win instead of producing a duplicate row.
        const string source = """
            package MyApp
            @assembly:System.Reflection.AssemblyInformationalVersionAttribute("1.3.0-explicit")

            func Main() {
            }
            """;

        var pe = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: "Issue2237Dedup", assemblyVersion: "9.9.9-override");
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        pe.Position = 0;

        using var peReader = new PEReader(pe, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();
        var assembly = md.GetAssemblyDefinition();

        var count = 0;
        foreach (var cah in assembly.GetCustomAttributes())
        {
            if (GetAttributeTypeName(md, cah) == "System.Reflection.AssemblyInformationalVersionAttribute")
            {
                count++;
            }
        }

        Assert.Equal(1, count);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> GetBinderDiagnostics(BoundGlobalScope scope)
    {
        return scope.Diagnostics;
    }

    private static MemoryStream Compile(string source)
    {
        var pe = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(pe);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        pe.Position = 0;
        return pe;
    }

    private static System.Collections.Generic.HashSet<string> GetAssemblyCustomAttributeTypeNames(MemoryStream pe)
    {
        using var peReader = new PEReader(pe, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();
        var assembly = md.GetAssemblyDefinition();

        var names = new System.Collections.Generic.HashSet<string>();
        foreach (var cah in assembly.GetCustomAttributes())
        {
            var name = GetAttributeTypeName(md, cah);
            if (name != null)
            {
                names.Add(name);
            }
        }

        return names;
    }

    private static string GetAttributeTypeName(MetadataReader md, CustomAttributeHandle cah)
    {
        var ca = md.GetCustomAttribute(cah);
        var ctor = ca.Constructor;
        if (ctor.Kind == HandleKind.MemberReference)
        {
            var mr = md.GetMemberReference((MemberReferenceHandle)ctor);
            if (mr.Parent.Kind == HandleKind.TypeReference)
            {
                var tr = md.GetTypeReference((TypeReferenceHandle)mr.Parent);
                return md.GetString(tr.Namespace) + "." + md.GetString(tr.Name);
            }
        }

        return null;
    }
}
