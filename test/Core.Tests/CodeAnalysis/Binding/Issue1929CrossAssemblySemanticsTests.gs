// <copyright file="Issue1929CrossAssemblySemanticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Reflection
import Xunit

/// Issue #1929: G# metadata imports must preserve data-struct semantics,
/// positional construction, receiver-clause extension methods, and friend-like
/// internal visibility across assembly boundaries.
open class Issue1929CrossAssemblySemanticsTests {
    @Fact
    func Imported_DataStruct_Semantics_RoundTrip_Through_Metadata() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue1929.Library.dll")
        EmitLibraryAssembly(libraryPath)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue1929.Library.Tests"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Demo
import Demo

func Run() int32 {
    let start = Point(1, 2)
    let moved = start with { x = 3 }
    let target = Point{ x: 10, y: 20 }
    return moved.DistanceTo(target) + moved.secretSauce()
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue1929.Library.Tests")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    /// Blocking review finding on #1953: naming a consumer assembly
    /// `<Owner>.Tests` must NOT unilaterally grant internal access.
    /// A library that never declares
    /// `@assembly:InternalsVisibleTo("...")` must reject an internal
    /// member access from a same-named-by-convention consumer.
    @Fact
    func Consumer_Named_Dot_Tests_Without_Producer_OptIn_Cannot_See_Internal_Members() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929NoOptIn")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "NoOptIn.Library.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Demo

data struct Point(x int32, y int32)

internal func (p Point) secretSauce() int32 {
    return (p.x * 100) + p.y
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "NoOptIn.Library")
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        // Naming convention only — the producer above never declared
        // InternalsVisibleTo for this name.
        resolver.CurrentAssemblyName = "NoOptIn.Library.Tests"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Demo
import Demo

func Run() int32 {
    let p = Point(1, 2)
    return p.secretSauce()
}`)))
        using let peStream2 = MemoryStream()
        let result = consumer.Emit(peStream2, pdbStream: nil, refStream: nil, assemblyName: "NoOptIn.Library.Tests")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    /// A consumer explicitly granted friendship via
    /// `@assembly:InternalsVisibleTo("...")` can see internal members
    /// even when its assembly name shares no naming convention with the
    /// producer at all (proving this is genuine producer opt-in, not a name
    /// heuristic).
    @Fact
    func Consumer_Explicitly_Granted_InternalsVisibleTo_Can_See_Internal_Members_Regardless_Of_Name() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929ExplicitOptIn")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "ExplicitOptIn.Library.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Demo

@assembly:InternalsVisibleTo("Totally.Unrelated.Consumer.Name")

data struct Point(x int32, y int32)

internal func (p Point) secretSauce() int32 {
    return (p.x * 100) + p.y
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "ExplicitOptIn.Library"
            )
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Totally.Unrelated.Consumer.Name"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Demo
import Demo

func Run() int32 {
    let p = Point(1, 2)
    return p.secretSauce()
}`)))
        using let peStream2 = MemoryStream()
        let result = consumer.Emit(
            peStream2,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Totally.Unrelated.Consumer.Name"
        )
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Consumer_Explicitly_Granted_InternalsVisibleTo_Can_Read_Internal_Instance_Field() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929InternalField")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "InternalField.Library.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Demo

@assembly:InternalsVisibleTo("InternalField.Consumer")

class Secret {
    internal var Value int32 = 42
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "InternalField.Library"
            )
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "InternalField.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import Demo

func Run(secret Secret) int32 -> secret.Value`)))
        using let output = MemoryStream()
        let result = consumer.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "InternalField.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Consumer_Explicitly_Granted_InternalsVisibleTo_Can_Call_InternalConstructor() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929InternalConstructor")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "InternalConstructor.Library.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Demo

@assembly:InternalsVisibleTo("InternalConstructor.Consumer")

class Secret {
    public let Value int32

    internal init(value int32) {
        Value = value
    }
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "InternalConstructor.Library"
            )
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "InternalConstructor.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import Demo

func Run() int32 -> Secret(value: 42).Value`)))
        using let output = MemoryStream()
        let result = consumer.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "InternalConstructor.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    /// Non-blocking review finding #2: `Compilation.AssemblyName` must be
    /// honored regardless of whether the caller touches
    /// (cref:Compilation.GlobalScope) (e.g. reading diagnostics) before
    /// or after setting it, as long as it is set before the first
    /// (cref:Compilation.GlobalScope) access — previously the assembly
    /// name was only pushed onto (cref:ReferenceResolver.CurrentAssemblyName)
    /// inside `Emit`, so any earlier `GlobalScope` access froze
    /// internal-visibility binding with an empty consumer name.
    @Fact
    func Setting_AssemblyName_Before_GlobalScope_Access_Makes_Internal_Visibility_Order_Independent() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue1929CallOrder")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "CallOrder.Library.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Demo

@assembly:InternalsVisibleTo("CallOrder.Library.Tests")

data struct Point(x int32, y int32)

internal func (p Point) secretSauce() int32 {
    return (p.x * 100) + p.y
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(libraryPath)
            let libResult = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "CallOrder.Library")
            Assert.True(libResult.Success, string.Join(Environment.NewLine, libResult.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Demo
import Demo

func Run() int32 {
    let p = Point(1, 2)
    return p.secretSauce()
}`))){AssemblyName = "CallOrder.Library.Tests"}
        // Force GlobalScope (and thus binding) before Emit ever runs — this
        // is exactly the order that used to freeze visibility with an empty
        // consumer name because CurrentAssemblyName was only ever set inside
        // Emit().
        let _ = consumer.GlobalScope.Diagnostics
        using let peStream2 = MemoryStream()
        let result = consumer.Emit(peStream2, pdbStream: nil, refStream: nil, assemblyName: "CallOrder.Library.Tests")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    /// Non-blocking review finding #3: the positional-ctor metadata payload
    /// must not silently drop a parameter whose name diverges from its
    /// backing field's name — (cref:ImportedTypeSymbol) now resolves
    /// each parameter's type via the backing field's metadata token first,
    /// falling back to name matching only when no token was recorded.
    @Fact
    func BuildPrimaryConstructorParameters_Resolves_By_FieldToken_Even_When_Name_Diverges() {
        let fieldType = TypeSymbol.Int32
        let backingField = FieldSymbol("x", fieldType, Accessibility.Public, isReadOnly: true)
        const fakeFieldToken = 0x04000042
        let fieldByToken = Dictionary[int32, FieldSymbol]{[fakeFieldToken] = backingField}
        // The parameter name intentionally does NOT match any field/property
        // name — simulating a future rename/mangling divergence — but the
        // token points at the real backing field.
        let semantics = ImportedTypeSemantics(
            MetadataToken: 0x02000005,
            IsValueType: true,
            IsData: true,
            PrimaryConstructorParameterNames: ImmutableArray.Create("renamedParam"),
            PrimaryConstructorParameterFieldTokens: ImmutableArray.Create(fakeFieldToken)
        )
        let method MethodInfo? = typeof(ImportedTypeSymbol).GetMethod(
            "BuildPrimaryConstructorParameters",
            BindingFlags.NonPublic | BindingFlags.Static
        )
        Assert.NotNull(method)
        let result = ImmutableArray[ParameterSymbol](
            method!!.Invoke(
                nil,
                []object{
                    typeof(object),
                    ImmutableArray[FieldSymbol].Empty,
                    ImmutableArray[PropertySymbol].Empty,
                    fieldByToken,
                    semantics
                }
            )
        )
        let parameter = Assert.Single(result)
        Assert.Equal("renamedParam", parameter.Name)
        Assert.Same(fieldType, parameter.Type)
    }

    shared {
        private func EmitLibraryAssembly(libraryPath string) {
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Demo

@assembly:InternalsVisibleTo("Issue1929.Library.Tests")

data struct Point(x int32, y int32)

func (p Point) DistanceTo(other Point) int32 {
    return (other.x - p.x) + (other.y - p.y)
}

internal func (p Point) secretSauce() int32 {
    return (p.x * 100) + p.y
}`))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue1929.Library")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
