// <copyright file="Issue3338ImportedAbstractMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

/// Issue #3338: concrete source classes must satisfy every effective abstract
/// CLR slot inherited from an imported base, including inaccessible internal
/// slots that cannot be implemented outside their declaring assembly.
class Issue3338ImportedAbstractMemberTests {
    @Fact
    func ConcreteExternalSubclassWithInaccessibleInternalAbstractMethod_ReportsGS0387() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitGSharpLibrary(directory, "Issue3338.Library", InternalAbstractLibrarySource)
            let result = CompileGSharp(`package Issue3338.Consumer
import Issue3338.Library

public class BasicRenderer : Renderer {
  public override func Render(value int32) int32 -> value
}`, "Issue3338.Consumer", libraryPath)
            Assert.False(result.Success)
            let diagnostic = Assert.Single(
                result.Diagnostics,
                (d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Id == "GS0387"
            )
            Assert.Equal(
                "'BasicRenderer' does not implement inherited abstract member 'Renderer.Prepare' (issue #987).",
                diagnostic.Message
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    @Fact
    func FriendAssemblyCanOverrideInternalAbstractMethod() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitGSharpLibrary(directory, "Issue3338.Library", InternalAbstractLibrarySource)
            let result = CompileGSharp(`package Issue3338.Friend
import Issue3338.Library

public class FriendlyRenderer : Renderer {
  internal override func Prepare() {
  }

  public override func Render(value int32) int32 -> value
}`, "Issue3338.Friend", libraryPath)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Message)
                )
            )
            Assert.DoesNotContain(
                result.Diagnostics,
                (d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> (d.Id is "GS0183" or "GS0387")
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    @Fact
    func PrivateProtectedAbstractMethodCannotUseGSharpProtectedOverride() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3338.PrivateProtectedLibrary", `using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Issue3338.PrivateProtectedFriend")]

namespace Issue3338.PrivateProtectedLibrary;

public abstract class RestrictedRenderer
{
    private protected abstract void Prepare();

    public abstract void Render();
}`)
            AssertMethodAttributes(
                libraryPath,
                "RestrictedRenderer",
                "Prepare",
                MethodAttributes.FamANDAssem | MethodAttributes.Abstract | MethodAttributes.Virtual | MethodAttributes.NewSlot,
                MethodAttributes.Final
            )
            let external = CompileGSharp(`package Issue3338.PrivateProtectedConsumer
import Issue3338.PrivateProtectedLibrary

public class ExternalRenderer : RestrictedRenderer {
  public override func Render() {
  }
}`, "Issue3338.PrivateProtectedConsumer", libraryPath)
            Assert.False(external.Success)
            let missing = Assert.Single(
                external.Diagnostics,
                (d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Id == "GS0387"
            )
            Assert.Equal(
                "'ExternalRenderer' does not implement inherited abstract member 'RestrictedRenderer.Prepare' (issue #987).",
                missing.Message
            )
            let friend = CompileGSharp(`package Issue3338.PrivateProtectedFriend
import Issue3338.PrivateProtectedLibrary

public open class FriendlyRenderer : RestrictedRenderer {
  protected override func Prepare() {
  }

  public override func Render() {
  }
}`, "Issue3338.PrivateProtectedFriend", libraryPath)
            Assert.False(friend.Success)
            Assert.Contains(
                friend.Diagnostics,
                (d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Id == "GS0183"
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    @Fact
    func OpenExternalSubclassMayDeferInaccessibleSlotAndEmitsAbstract() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitGSharpLibrary(directory, "Issue3338.Library", InternalAbstractLibrarySource)
            let result = CompileGSharp(`package Issue3338.Deferred
import Issue3338.Library

public open class DeferredRenderer : Renderer {
  public override func Render(value int32) int32 -> value
}`, "Issue3338.Deferred", libraryPath)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Message)
                )
            )
            Assert.DoesNotContain(
                result.Diagnostics,
                (d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Id == "GS0387"
            )
            AssertTypeIsAbstract(result.Image, "DeferredRenderer")
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    @Fact
    func SameCompilationInternalAbstractOverrideRemainsValid() {
        let result = CompileGSharp(`package Issue3338.Local

public open class LocalBase {
  internal open func Prepare();
}

public class LocalDerived : LocalBase {
  internal override func Prepare() {
  }
}`, "Issue3338.Local")
        Assert.True(
            result.Success,
            string.Join(
                Environment.NewLine,
                result.Diagnostics.Select((d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Message)
            )
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Id == "GS0387"
        )
    }

    @Fact
    func TransitiveGenericMethodsPropertiesAndEventsUseEffectiveAbstractSlots() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3338.GenericLibrary", `using System;

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
}`)
            let shadowLibraryPath = EmitGSharpLibrary(directory, "Issue3338.GenericShadowLibrary", `package Issue3338.GenericShadowLibrary
import Issue3338.GenericLibrary

public open class ShadowMid[U] : Root[Box[U]] {
  public open func Transform(value Box[U]) Box[U] -> value
}`, libraryPath)
            AssertMethodAttributes(
                libraryPath,
                "Root`1",
                "Transform",
                MethodAttributes.Abstract | MethodAttributes.Virtual | MethodAttributes.NewSlot,
                MethodAttributes.Final
            )
            AssertMethodAttributes(
                shadowLibraryPath,
                "ShadowMid`1",
                "Transform",
                MethodAttributes.Virtual | MethodAttributes.NewSlot,
                MethodAttributes.Abstract | MethodAttributes.Final
            )
            let complete = CompileGSharp(`package Issue3338.GenericConsumer
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
}`, "Issue3338.GenericConsumer", libraryPath)
            Assert.True(
                complete.Success,
                string.Join(
                    Environment.NewLine,
                    complete.Diagnostics.Select((d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Message)
                )
            )
            Assert.DoesNotContain(
                complete.Diagnostics,
                (d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Id == "GS0387"
            )
            AssertTypeIsAbstract(complete.Image, "Deferred`1")
            let missingAccessors = CompileGSharp(`package Issue3338.GenericMissing
import Issue3338.GenericLibrary

public class Payload {
}

public class Missing : Mid[Payload] {
  public override func Echo[U](value U) U -> value
}`, "Issue3338.GenericMissing", libraryPath)
            Assert.False(missingAccessors.Success)
            let missing = missingAccessors
                .Diagnostics
                .Where((d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Id == "GS0387")
                .Select((d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Message!!)
                .ToArray()
            Assert.Equal(4, missing.Length)
            Assert.Contains(missing, (message string) -> message.Contains("Current.get", StringComparison.Ordinal))
            Assert.Contains(missing, (message string) -> message.Contains("Current.set", StringComparison.Ordinal))
            Assert.Contains(missing, (message string) -> message.Contains("Changed.add", StringComparison.Ordinal))
            Assert.Contains(missing, (message string) -> message.Contains("Changed.remove", StringComparison.Ordinal))
            Assert.DoesNotContain(missing, (message string) -> message.Contains("Transform", StringComparison.Ordinal))
            Assert.DoesNotContain(missing, (message string) -> message.Contains("Echo", StringComparison.Ordinal))
            let shadowedSlot = CompileGSharp(`package Issue3338.GenericShadow
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
}`, "Issue3338.GenericShadow", libraryPath, shadowLibraryPath)
            Assert.False(shadowedSlot.Success)
            let shadowedDiagnostic = Assert.Single(
                shadowedSlot.Diagnostics,
                (d Issue3338ImportedAbstractMemberTests.DiagnosticInfo) -> d.Id == "GS0387"
            )
            Assert.Contains("Transform", shadowedDiagnostic.Message, StringComparison.Ordinal)
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    private data struct CompileResult(
        Success bool,
        Diagnostics[]Issue3338ImportedAbstractMemberTests.DiagnosticInfo,
        Image[]uint8
    ) : IEquatable[Issue3338ImportedAbstractMemberTests.CompileResult] { }

    private data struct DiagnosticInfo(Id string, Message string?) : IEquatable[
        Issue3338ImportedAbstractMemberTests.DiagnosticInfo
    ] { }

    shared {
        private const InternalAbstractLibrarySource string = `package Issue3338.Library

@assembly:InternalsVisibleTo("Issue3338.Friend")

public open class Renderer {
  internal open func Prepare();

  internal open func Optional() {
  }

  public open func Render(value int32) int32;
}`

        private func CompileGSharp(
            source string,
            assemblyName string,
            references ...string
        ) Issue3338ImportedAbstractMemberTests
            .CompileResult {
            using let resolver = if references.Length == 0 {
                ReferenceResolver.Default()
            } else {
                ReferenceResolver.WithReferences(references)
            }
            resolver.CurrentAssemblyName = assemblyName
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = assemblyName
            }
            using let output = MemoryStream()
            let emit = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            return Issue3338ImportedAbstractMemberTests.CompileResult(
                emit.Success,
                emit
                    .Diagnostics
                    .Select(
                    (d GSharp.Core.CodeAnalysis.Diagnostic) -> Issue3338ImportedAbstractMemberTests.DiagnosticInfo(
                        d.Id,
                        d.Message
                    )
                )
                    .ToArray(),
                output.ToArray()
            )
        }

        private func EmitGSharpLibrary(
            directory string,
            assemblyName string,
            source string,
            references ...string
        ) string {
            let path = Path.Combine(directory, assemblyName + ".dll")
            using let resolver = if references.Length == 0 {
                ReferenceResolver.Default()
            } else {
                ReferenceResolver.WithReferences(references)
            }
            resolver.CurrentAssemblyName = assemblyName
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = assemblyName,
                IsLibrary = true
            }
            using let output = File.Create(path)
            let emit = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return path
        }

        private func EmitCSharpLibrary(directory string, assemblyName string, source string) string {
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, assemblyName + ".dll")
            using let output = File.Create(path)
            let emit = compilation.Emit(output)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return path
        }

        private func AssertTypeIsAbstract(image[]uint8, typeName string) {
            using let stream = MemoryStream(image)
            using let peReader = PEReader(stream)
            let metadata = peReader.GetMetadataReader()
            for handle in metadata.TypeDefinitions {
                let type = metadata.GetTypeDefinition(handle)
                if metadata.GetString(type.Name) == typeName {
                    Assert.True((type.Attributes & TypeAttributes.Abstract) != 0)
                    return
                }
            }
            Assert.Fail("Type '$typeName' was not emitted.")
        }

        private func AssertMethodAttributes(
            assemblyPath string,
            typeName string,
            methodName string,
            required MethodAttributes,
            forbidden MethodAttributes
        ) {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let metadata = peReader.GetMetadataReader()
            for typeHandle in metadata.TypeDefinitions {
                let type = metadata.GetTypeDefinition(typeHandle)
                if metadata.GetString(type.Name) != typeName {
                    continue
                }
                for methodHandle in type.GetMethods() {
                    let method = metadata.GetMethodDefinition(methodHandle)
                    if metadata.GetString(method.Name) != methodName {
                        continue
                    }
                    Assert.True(
                        (method.Attributes & required) == required,
                        "$typeName.$methodName attributes ${method.Attributes} do not include $required."
                    )
                    Assert.True(
                        (method.Attributes & forbidden) == 0,
                        "$typeName.$methodName attributes ${method.Attributes} include forbidden $forbidden."
                    )
                    return
                }
                Assert.Fail("Method '$typeName.$methodName' was not emitted.")
            }
            Assert.Fail("Type '$typeName' was not emitted.")
        }

        private func CreateOutputDirectory() string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3338ImportedAbstractMemberTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }

        private func DeleteOutputDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { }
        }
    }
}
