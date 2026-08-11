// <copyright file="Issue3338ImportedAbstractMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3338: concrete source classes must satisfy every effective abstract
/// CLR slot inherited from an imported base, including inaccessible internal
/// slots that cannot be implemented outside their declaring assembly.
/// </summary>
public sealed class Issue3338ImportedAbstractMemberTests
{
    private const string InternalAbstractLibrarySource = """
        package Issue3338.Library

        @assembly:InternalsVisibleTo("Issue3338.Friend")

        public open class Renderer {
          internal open func Prepare();

          internal open func Optional() {
          }

          public open func Render(value int32) int32;
        }
        """;

    [Fact]
    public void ConcreteExternalSubclassWithInaccessibleInternalAbstractMethod_ReportsGS0387()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitGSharpLibrary(
                directory,
                "Issue3338.Library",
                InternalAbstractLibrarySource);
            var result = CompileGSharp(
                """
                package Issue3338.Consumer
                import Issue3338.Library

                public class BasicRenderer : Renderer {
                  public override func Render(value int32) int32 -> value
                }
                """,
                "Issue3338.Consumer",
                libraryPath);

            Assert.False(result.Success);
            var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0387");
            Assert.Contains("Prepare", diagnostic.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("Optional", diagnostic.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("Renderer.Render", diagnostic.Message, StringComparison.Ordinal);
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    [Fact]
    public void FriendAssemblyCanOverrideInternalAbstractMethod()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitGSharpLibrary(
                directory,
                "Issue3338.Library",
                InternalAbstractLibrarySource);
            var result = CompileGSharp(
                """
                package Issue3338.Friend
                import Issue3338.Library

                public class FriendlyRenderer : Renderer {
                  internal override func Prepare() {
                  }

                  public override func Render(value int32) int32 -> value
                }
                """,
                "Issue3338.Friend",
                libraryPath);

            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.Message)));
            Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0183" or "GS0387");
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    [Fact]
    public void OpenExternalSubclassMayDeferInaccessibleSlotAndEmitsAbstract()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitGSharpLibrary(
                directory,
                "Issue3338.Library",
                InternalAbstractLibrarySource);
            var result = CompileGSharp(
                """
                package Issue3338.Deferred
                import Issue3338.Library

                public open class DeferredRenderer : Renderer {
                  public override func Render(value int32) int32 -> value
                }
                """,
                "Issue3338.Deferred",
                libraryPath);

            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.Message)));
            Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0387");
            AssertTypeIsAbstract(result.Image, "DeferredRenderer");
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    [Fact]
    public void SameCompilationInternalAbstractOverrideRemainsValid()
    {
        var result = CompileGSharp(
            """
            package Issue3338.Local

            public open class LocalBase {
              internal open func Prepare();
            }

            public class LocalDerived : LocalBase {
              internal override func Prepare() {
              }
            }
            """,
            "Issue3338.Local");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.Message)));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0387");
    }

    [Fact]
    public void TransitiveGenericMethodsPropertiesAndEventsUseEffectiveAbstractSlots()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(
                directory,
                "Issue3338.GenericLibrary",
                """
                using System;

                namespace Issue3338.GenericLibrary;

                public sealed class Box<T>
                {
                }

                public abstract class Root<T>
                {
                    public abstract T Transform(T value);

                    public abstract U Echo<U>(U value);

                    public abstract T Current { get; set; }

                    public abstract event EventHandler Changed;
                }

                public abstract class Mid<U> : Root<Box<U>>
                {
                    public override Box<U> Transform(Box<U> value) => value;
                }
                """);
            var shadowLibraryPath = EmitGSharpLibrary(
                directory,
                "Issue3338.GenericShadowLibrary",
                """
                package Issue3338.GenericShadowLibrary
                import Issue3338.GenericLibrary

                public open class ShadowMid[U] : Root[Box[U]] {
                  public open func Transform(value Box[U]) Box[U] -> value
                }
                """,
                libraryPath);

            var complete = CompileGSharp(
                """
                package Issue3338.GenericConsumer
                import System
                import Issue3338.GenericLibrary

                public class Payload {
                }

                public open class Deferred[T] : Mid[T] {
                }

                public class Complete : Deferred[Payload] {
                  public override func Echo[U](value U) U -> value

                  public override prop Current Box[Payload] {
                    get {
                      return Box[Payload]()
                    }
                    set {
                    }
                  }

                  public override event Changed EventHandler {
                    add {
                    }
                    remove {
                    }
                  }
                }
                """,
                "Issue3338.GenericConsumer",
                libraryPath);

            Assert.True(complete.Success, string.Join(Environment.NewLine, complete.Diagnostics.Select(d => d.Message)));
            Assert.DoesNotContain(complete.Diagnostics, d => d.Id == "GS0387");
            AssertTypeIsAbstract(complete.Image, "Deferred`1");

            var missingAccessors = CompileGSharp(
                """
                package Issue3338.GenericMissing
                import Issue3338.GenericLibrary

                public class Payload {
                }

                public class Missing : Mid[Payload] {
                  public override func Echo[U](value U) U -> value
                }
                """,
                "Issue3338.GenericMissing",
                libraryPath);

            Assert.False(missingAccessors.Success);
            var missing = missingAccessors.Diagnostics
                .Where(d => d.Id == "GS0387")
                .Select(d => d.Message)
                .ToArray();
            Assert.Equal(4, missing.Length);
            Assert.Contains(missing, message => message.Contains("Current.get", StringComparison.Ordinal));
            Assert.Contains(missing, message => message.Contains("Current.set", StringComparison.Ordinal));
            Assert.Contains(missing, message => message.Contains("Changed.add", StringComparison.Ordinal));
            Assert.Contains(missing, message => message.Contains("Changed.remove", StringComparison.Ordinal));
            Assert.DoesNotContain(missing, message => message.Contains("Transform", StringComparison.Ordinal));
            Assert.DoesNotContain(missing, message => message.Contains("Echo", StringComparison.Ordinal));

            var shadowedSlot = CompileGSharp(
                """
                package Issue3338.GenericShadow
                import System
                import Issue3338.GenericLibrary
                import Issue3338.GenericShadowLibrary

                public class Payload {
                }

                public class ShadowLeaf : ShadowMid[Payload] {
                  public override func Transform(value Box[Payload]) Box[Payload] -> value

                  public override func Echo[U](value U) U -> value

                  public override prop Current Box[Payload] {
                    get {
                      return Box[Payload]()
                    }
                    set {
                    }
                  }

                  public override event Changed EventHandler {
                    add {
                    }
                    remove {
                    }
                  }
                }
                """,
                "Issue3338.GenericShadow",
                libraryPath,
                shadowLibraryPath);

            Assert.False(shadowedSlot.Success);
            var shadowedDiagnostic = Assert.Single(
                shadowedSlot.Diagnostics,
                d => d.Id == "GS0387");
            Assert.Contains("Transform", shadowedDiagnostic.Message, StringComparison.Ordinal);
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    private static CompileResult CompileGSharp(
        string source,
        string assemblyName,
        params string[] references)
    {
        using var resolver = references.Length == 0
            ? ReferenceResolver.Default()
            : ReferenceResolver.WithReferences(references);
        resolver.CurrentAssemblyName = assemblyName;
        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(source)))
        {
            AssemblyName = assemblyName,
        };

        using var output = new MemoryStream();
        var emit = compilation.Emit(
            output,
            pdbStream: null,
            refStream: null,
            assemblyName: assemblyName);
        return new CompileResult(
            emit.Success,
            emit.Diagnostics.Select(d => new DiagnosticInfo(d.Id, d.Message)).ToArray(),
            output.ToArray());
    }

    private static string EmitGSharpLibrary(
        string directory,
        string assemblyName,
        string source,
        params string[] references)
    {
        var path = Path.Combine(directory, assemblyName + ".dll");
        using var resolver = references.Length == 0
            ? ReferenceResolver.Default()
            : ReferenceResolver.WithReferences(references);
        resolver.CurrentAssemblyName = assemblyName;
        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(source)))
        {
            AssemblyName = assemblyName,
            IsLibrary = true,
        };

        using var output = File.Create(path);
        var emit = compilation.Emit(
            output,
            pdbStream: null,
            refStream: null,
            assemblyName: assemblyName);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return path;
    }

    private static string EmitCSharpLibrary(
        string directory,
        string assemblyName,
        string source)
    {
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(directory, assemblyName + ".dll");
        using var output = File.Create(path);
        var emit = compilation.Emit(output);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return path;
    }

    private static void AssertTypeIsAbstract(byte[] image, string typeName)
    {
        using var stream = new MemoryStream(image);
        using var peReader = new PEReader(stream);
        var metadata = peReader.GetMetadataReader();
        foreach (var handle in metadata.TypeDefinitions)
        {
            var type = metadata.GetTypeDefinition(handle);
            if (metadata.GetString(type.Name) == typeName)
            {
                Assert.True((type.Attributes & TypeAttributes.Abstract) != 0);
                return;
            }
        }

        Assert.Fail($"Type '{typeName}' was not emitted.");
    }

    private static string CreateOutputDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3338ImportedAbstractMemberTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void DeleteOutputDirectory(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private readonly record struct CompileResult(
        bool Success,
        DiagnosticInfo[] Diagnostics,
        byte[] Image);

    private readonly record struct DiagnosticInfo(string Id, string Message);
}
