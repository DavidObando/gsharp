// <copyright file="Issue3873ByRefLikeBackingFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3873: GS0219 (issue #367 / ADR-0058 — a by-ref-like value cannot escape
/// to the heap) only ever saw fields the user SPELLED OUT. A compiler-synthesized
/// backing field — an auto-property's <c>&lt;P&gt;k__BackingField</c> — went
/// unchecked, so <c>struct X { prop Values Span[int32] }</c> compiled clean and
/// produced an assembly the CLR cannot load at all:
/// <c>TypeLoadException: A ByRef or ByRef-like type cannot be used as the type
/// for an instance field in a non-ByRef-like type</c>, thrown out of
/// <c>GetExportedTypes()</c> — which is exactly the call xunit discovery makes.
/// <para>
/// That mattered beyond one member shape. In #3869 this was the SECOND
/// independent guard to fail on the same hazard (the first being cs2gs dropping
/// the <c>ref</c> from a <c>ref struct</c>, fixed in #3872), and both failing is
/// what turned a compile error into a migrated test assembly that discovered zero
/// tests and still reported green.
/// </para>
/// <para>
/// The assertions below are deliberately not ILVerify-based: the failure mode is a
/// runtime type-load failure, and on this effort a defect has already passed
/// ILVerify and still thrown at load (#3764). So the illegal shapes must be
/// rejected at COMPILE time, and the legal <c>ref struct</c> shape must still
/// compile, load, and enumerate through <c>GetExportedTypes()</c>.
/// </para>
/// </summary>
public class Issue3873ByRefLikeBackingFieldEmitTests
{
    /// <summary>
    /// The #3873 repro itself: a non-<c>ref</c> struct whose auto-property is a
    /// <c>Span[T]</c>. Rejected at compile time, where the identical spelled-out
    /// field has always been rejected.
    /// </summary>
    [Fact]
    public void ByRefLikeAutoProperty_OnStruct_ReportsGS0219()
    {
        AssertRejected(
            """
            package P
            import System
            struct Holder { prop Values Span[int32] }
            """,
            nameof(ByRefLikeAutoProperty_OnStruct_ReportsGS0219));
    }

    /// <summary>
    /// A class is never by-ref-like, so its auto-property backing field is subject
    /// to the same rule — and produces the same unloadable assembly.
    /// </summary>
    [Fact]
    public void ByRefLikeAutoProperty_OnClass_ReportsGS0219()
    {
        AssertRejected(
            """
            package P
            import System
            class Holder { prop Values Span[int32] }
            """,
            nameof(ByRefLikeAutoProperty_OnClass_ReportsGS0219));
    }

    /// <summary>
    /// A USER-declared <c>ref struct</c> (not just an imported <c>Span[T]</c>) is
    /// the same hazard: the check must be about by-ref-like-ness, not about a
    /// hard-coded set of imported type names.
    /// </summary>
    [Fact]
    public void UserRefStructAutoProperty_OnStruct_ReportsGS0219()
    {
        AssertRejected(
            """
            package P
            ref struct Accumulator { var Total int32 }
            struct Holder { prop Slot Accumulator }
            """,
            nameof(UserRefStructAutoProperty_OnStruct_ReportsGS0219));
    }

    /// <summary>
    /// A <c>shared</c> (static) auto-property is illegal EVEN INSIDE a
    /// <c>ref struct</c>: a static field is rooted on the heap, so there is no
    /// stack-confined container that makes it legal. The runtime distinguishes the
    /// two cases explicitly ("... as the type for a static field").
    /// </summary>
    [Fact]
    public void ByRefLikeSharedAutoProperty_InRefStruct_ReportsGS0219()
    {
        AssertRejected(
            """
            package P
            import System
            ref struct Holder { shared { prop Values Span[int32] } }
            """,
            nameof(ByRefLikeSharedAutoProperty_InRefStruct_ReportsGS0219));
    }

    /// <summary>
    /// Anti-vacuity, and the load-bearing half: an INSTANCE auto-property of a
    /// by-ref-like type inside a genuine <c>ref struct</c> is legal C#/G# and must
    /// keep compiling — and the emitted assembly must still type-load and
    /// enumerate. Without this test, "always report GS0219 for a by-ref-like
    /// property" would satisfy every assertion above while breaking the one shape
    /// the language is supposed to support (ADR-0058, <c>samples/UserRefStruct.gs</c>).
    /// </summary>
    [Fact]
    public void ByRefLikeAutoProperty_InRefStruct_CompilesAndTheAssemblyTypeLoads()
    {
        string outputPath = CompileLibrary(
            """
            package P
            import System
            ref struct Holder { prop Values Span[int32] }
            """,
            nameof(ByRefLikeAutoProperty_InRefStruct_CompilesAndTheAssemblyTypeLoads));

        using (var pe = new PEReader(File.OpenRead(outputPath)))
        {
            MetadataReader metadata = pe.GetMetadataReader();
            TypeDefinition definition = metadata.TypeDefinitions
                .Select(metadata.GetTypeDefinition)
                .Single(candidate => metadata.GetString(candidate.Name) == "Holder");

            Assert.Contains(
                definition.GetCustomAttributes()
                    .Select(metadata.GetCustomAttribute)
                    .Select(attribute => AttributeTypeName(metadata, attribute)),
                name => name == "IsByRefLikeAttribute");

            // The property really is backed by a field — otherwise this whole
            // test would be vacuous, since a field-less property is trivially
            // loadable.
            Assert.Contains(
                definition.GetFields()
                    .Select(metadata.GetFieldDefinition)
                    .Select(field => metadata.GetString(field.Name)),
                name => name.Contains("Values", StringComparison.Ordinal));
        }

        // The CLR type loader, not the binder, is what has to accept this.
        var loadContext = new AssemblyLoadContext(
            nameof(ByRefLikeAutoProperty_InRefStruct_CompilesAndTheAssemblyTypeLoads),
            isCollectible: true);
        try
        {
            Assembly assembly = loadContext.LoadFromAssemblyPath(outputPath);
            Assert.Contains(assembly.GetExportedTypes(), type => type.Name == "Holder");
        }
        finally
        {
            loadContext.Unload();
        }
    }

    /// <summary>
    /// Anti-vacuity: a COMPUTED property whose type is by-ref-like has no backing
    /// field at all, so it is legal on an ordinary class and must not be reported.
    /// (An indexer cannot reach this rule by construction — G# has no auto-indexer
    /// form; a bodiless indexer is GS0371 — so there is nothing to guard there.)
    /// </summary>
    [Fact]
    public void ByRefLikeComputedProperty_OnClass_IsPermitted()
    {
        CompileLibrary(
            """
            package P
            import System
            class Holder {
                private let values []int32 = []int32{1, 2}
                prop Slice Span[int32] {
                    get { return Span[int32](values) }
                }
            }
            """,
            nameof(ByRefLikeComputedProperty_OnClass_IsPermitted));
    }

    /// <summary>
    /// The same blind spot swallowed a managed pointer (<c>*T</c>) auto-property,
    /// which is not a field type either (ADR-0039 §4 — CLR metadata has no
    /// ELEMENT_TYPE_BYREF slot in a FieldDef signature). It used to reach the
    /// signature encoder and crash it (GS9998, an internal error); it must report
    /// the same user-facing rule the spelled-out field does (GS9006).
    /// </summary>
    [Fact]
    public void PointerTypedAutoProperty_ReportsFieldTypeError_NotAnInternalCrash()
    {
        (int exitCode, string diagnostics) = Compile(
            """
            package P
            struct Holder { prop Values *int32 }
            """,
            nameof(PointerTypedAutoProperty_ReportsFieldTypeError_NotAnInternalCrash));

        Assert.True(exitCode != 0, "A pointer-typed auto-property must not compile:\n" + diagnostics);
        Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal);
        Assert.Contains("GS9006", diagnostics, StringComparison.Ordinal);
    }

    private static void AssertRejected(string source, string testName)
    {
        (int exitCode, string diagnostics) = Compile(source, testName);

        Assert.True(
            exitCode != 0,
            $"{testName}: the source must be rejected — it emits an assembly the CLR cannot load. Output:\n" +
                diagnostics);
        Assert.Contains("GS0219", diagnostics, StringComparison.Ordinal);
    }

    private static string CompileLibrary(string source, string testName)
    {
        string directory = CreateArtifactDirectory(testName);
        string outputPath = Path.Combine(directory, "test.dll");
        (int exitCode, string diagnostics) = CompileTo(source, outputPath);

        Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal);
        Assert.True(exitCode == 0, $"{testName}: gsc failed:\n{diagnostics}");
        return outputPath;
    }

    private static (int ExitCode, string Diagnostics) Compile(string source, string testName)
    {
        string directory = CreateArtifactDirectory(testName);
        return CompileTo(source, Path.Combine(directory, "test.dll"));
    }

    private static (int ExitCode, string Diagnostics) CompileTo(string source, string outputPath)
    {
        string sourcePath = Path.Combine(Path.GetDirectoryName(outputPath)!, "test.gs");
        File.WriteAllText(sourcePath, source);

        string[] args =
        {
            "/out:" + outputPath,
            "/target:library",
            "/targetframework:net10.0",
            sourcePath,
        };

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        TextWriter previousOut = Console.Out;
        TextWriter previousErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        return (exitCode, compileOut.ToString() + compileErr.ToString());
    }

    private static string AttributeTypeName(MetadataReader metadata, CustomAttribute attribute)
    {
        switch (attribute.Constructor.Kind)
        {
            case HandleKind.MemberReference:
                MemberReference member = metadata.GetMemberReference(
                    (MemberReferenceHandle)attribute.Constructor);
                return member.Parent.Kind == HandleKind.TypeReference
                    ? metadata.GetString(metadata.GetTypeReference((TypeReferenceHandle)member.Parent).Name)
                    : string.Empty;
            case HandleKind.MethodDefinition:
                MethodDefinition method = metadata.GetMethodDefinition(
                    (MethodDefinitionHandle)attribute.Constructor);
                return metadata.GetString(metadata.GetTypeDefinition(method.GetDeclaringType()).Name);
            default:
                return string.Empty;
        }
    }

    private static string CreateArtifactDirectory(string testName)
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3873-artifacts",
            testName,
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
