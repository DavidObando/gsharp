// <copyright file="Issue4677NonVirtualClassMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import System.Threading.Tasks
import GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharpSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import System

/// Issue #4677: ordinary methods on G# classes must have the same CLR
/// virtuality metadata as equivalent C# methods. ADR-0017 specifies that
/// methods are non-virtual unless declared `open`.
/// @remarks ADR-0154 witness: on the pre-fix compiler, the two ordinary-method rows
/// failed with `Virtual | NewSlot | Final` present, while the open-method
/// control passed. The fixed compiler passes all three rows. This fixture
/// compares MethodDef attributes from both compilers.
/// The four iterator rows were red at d664fdaf0: all seven sync / nine async
/// interface methods lacked their virtual slots. They pass with the fix,
/// including interface maps and enumeration through closed generic types.
/// On 7744de4d1, inherited method/getter rows were red: Roslyn selectively
/// emitted virtual-final slots on the base, while G# omitted them. Unused
/// members and accessors remained non-virtual in both compilers.
/// Disabling the inherited-slot plan makes ten parity rows and the runtime
/// witness fail, while thirteen non-virtual/open/iterator controls pass.
class Issue4677NonVirtualClassMethodEmitTests {
    @Theory
    @InlineData("Closed", "Plain")
    @InlineData("OpenClass", "Plain")
    @InlineData("OpenClass", "Extensible")
    @InlineData("InheritedBase", "Implemented")
    @InlineData("InheritedBase", "get_Value")
    @InlineData("InheritedBase", "Unused")
    @InlineData("InheritedBase", "get_Stored")
    @InlineData("InheritedBase", "set_Stored")
    @InlineData("InheritedBase", "get_Mutable")
    @InlineData("InheritedBase", "set_Mutable")
    @InlineData("GenericSourceBase`1", "get_Data")
    @InlineData("GenericSourceBase`1", "set_Data")
    @InlineData("GenericClrBase`1", "get_Current")
    @InlineData("GenericClrBase`1", "set_Current")
    @InlineData("GenericClrBase`1", "MoveNext")
    @InlineData("GenericClrBase`1", "Reset")
    @InlineData("GenericClrBase`1", "Dispose")
    @InlineData("ExplicitBase", "Chosen")
    @InlineData("ExplicitBase", "get_Token")
    func InstanceMethodAttributes_MatchEquivalentCSharp(typeName string, methodName string) {
        let csharp = EmitCSharp()
        let csharpAttributes = FindMethod(csharp, typeName, methodName)
        Assert.Equal(csharpAttributes, FindMethod(EmitGSharp(), typeName, methodName))
        Assert.Equal(csharpAttributes, FindMethod(EmitGSharp(referenceAssembly: true), typeName, methodName))
    }

    @Fact
    func InheritedInterfaceMembers_DispatchThroughSelectedBaseSlots() {
        let context = AssemblyLoadContext(
            "InheritedInterfaceMembers_DispatchThroughSelectedBaseSlots",
            isCollectible: true
        )
        try {
            using let stream = MemoryStream(EmitGSharp())
            let assembly = context.LoadFromStream(stream)
            Assert.NotEmpty(assembly.GetTypes())
            let leaf = assembly.GetType("MethodParity.InheritedLeaf", throwOnError: true) ??
                throw InvalidOperationException("Missing inherited-interface fixture.")
            let iface = assembly.GetType("MethodParity.IInherited", throwOnError: true) ??
                throw InvalidOperationException("Missing inherited interface.")
            let map_ = leaf.GetInterfaceMap(iface)
            Assert.Equal(5, map_.TargetMethods.Length)
            Assert.All(
                map_.TargetMethods,
                (method MethodInfo) -> Assert.Equal("InheritedBase", method.DeclaringType?.Name)
            )
            let instance object? = Activator.CreateInstance(leaf)
            Assert.Equal(7, iface.GetMethod("Implemented")?.Invoke(instance, nil))
            Assert.Equal(9, iface.GetProperty("Value")?.GetValue(instance))
            let genericLeaf = assembly.GetType("MethodParity.GenericClrLeaf", throwOnError: true) ??
                throw InvalidOperationException("Missing generic inherited-interface fixture.")
            let enumerator = Assert.IsAssignableFrom[IEnumerator[int32]](Activator.CreateInstance(genericLeaf))
            Assert.False(enumerator.MoveNext())
            Assert.Equal(0, enumerator.Current)
            enumerator.Reset()
            enumerator.Dispose()
            let genericMap = genericLeaf.GetInterfaceMap(typeof(IEnumerator[int32]))
            Assert.Single(genericMap.TargetMethods)
            Assert.Equal("GenericClrBase`1", genericMap.TargetMethods[0].DeclaringType?.Name)
        } finally {
            context.Unload()
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    async func IteratorInterfaceMethods_KeepVirtualSlots(isAsync bool, generic bool) {
        let element = if generic {
            "T"
        } else {
            "int32"
        }
        let source = (`package IteratorSlots
import System.Threading.Tasks
` + "${(if isAsync { "async " } else { "" })}" + `func Values` + "${(if generic { "[T]" } else { "" })}" + `(value ` + "$element" + `) sequence[` + "$element" + `] {
    ` + "${(if isAsync { "await Task.Delay(1)" } else { "" })}" + `
    yield value
}`)
        let image = EmitGSharp(source)
        {
            using let pe = PEReader(MemoryStream(image))
            let metadata = pe.GetMetadataReader()
            let stateMachine = metadata
                .TypeDefinitions
                .Select(metadata.GetTypeDefinition)
                .Single(
                (type TypeDefinition) -> metadata.GetString(type.Name).StartsWith(
                    "<Values>d__",
                    StringComparison.Ordinal
                )
            )
            let methods = stateMachine
                .GetMethods()
                .Select(metadata.GetMethodDefinition)
                .Where((method MethodDefinition) -> metadata.GetString(method.Name) != ".ctor")
                .ToArray()
            Assert.Equal(
                if isAsync {
                    9
                } else {
                    7
                },
                methods.Length
            )
            Assert.All(
                methods,
                (method MethodDefinition) -> Assert.Equal(
                    MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final,
                    method.Attributes
                )
            )
        }
        let context = AssemblyLoadContext("IteratorInterfaceMethods_KeepVirtualSlots", isCollectible: true)
        try {
            using let stream = MemoryStream(image)
            let assembly = context.LoadFromStream(stream)
            let types = assembly.GetTypes()
            var stateMachine = types.Single(
                (type Type) -> type.Name.StartsWith("<Values>d__", StringComparison.Ordinal)
            )
            if generic {
                stateMachine = stateMachine.MakeGenericType(typeof(int32))
            }
            let interfaces = stateMachine.GetInterfaces()
            Assert.Equal(5, interfaces.Length)
            Assert.All(
                interfaces,
                (type Type) -> {
                    let targets = stateMachine.GetInterfaceMap(type).TargetMethods
                    Assert.NotEmpty(targets)
                    Assert.All(targets, (method MethodInfo) -> Assert.True(method.IsVirtual && method.IsFinal))
                }
            )
            var kickoff MethodInfo? = types.Single((type Type) -> type.Name == "<Program>").GetMethod("Values")
            Assert.NotNull(kickoff)
            if generic {
                kickoff = kickoff!!.MakeGenericMethod(typeof(int32))
            }
            let values = List[int32]()
            let result object? = kickoff!!.Invoke(nil, []object{7})
            if isAsync {
                await for value in Assert.IsAssignableFrom[IAsyncEnumerable[int32]](result) {
                    values.Add(value)
                }
            } else {
                values.AddRange(Assert.IsAssignableFrom[IEnumerable[int32]](result))
            }
            Assert.Equal([]int32{7}, values)
        } finally {
            context.Unload()
        }
    }

    shared {
        private const GSharpSource string = `package MethodParity

public class Closed {
    public func Plain() int32 { return 1 }
}

open class OpenClass {
    public func Plain() int32 { return 1 }
    open func Extensible() int32 { return 2 }
}

interface IInherited {
    func Implemented() int32;
    prop Value int32 { get; }
    prop Stored int32 { get; }
    prop Mutable int32 { get; set; }
}

open class InheritedBase {
    public func Implemented() int32 { return 7 }
    public func Unused() int32 { return 8 }
    public prop Value int32 -> 9
    public prop Stored int32 { get; set; }
    public prop Mutable int32 { get; set; }
}

class InheritedLeaf : InheritedBase, IInherited { }

interface IGenericInherited[T] { prop Data T { get; } }
open class GenericSourceBase[T] { public prop Data T { get; set; } }
class GenericSourceLeaf : GenericSourceBase[int32], IGenericInherited[int32] { }

open class GenericClrBase[T] {
    public prop Current T { get; set; }
    public func MoveNext() bool { return false }
    public func Reset() { }
    public func Dispose() { }
}
class GenericClrLeaf : GenericClrBase[int32], System.Collections.Generic.IEnumerator[int32] {
    prop (System.Collections.IEnumerator) Current object -> 0
}

interface ISelected {
    func Chosen() int32;
    prop Token int32 { get; }
}
open class ExplicitBase {
    public func Chosen() int32 { return 1 }
    public prop Token int32 -> 1
}
class ExplicitLeaf : ExplicitBase, ISelected {
    private func (ISelected) Chosen() int32 { return 2 }
    private prop (ISelected) Token int32 -> 2
}`

        private const CSharpSource string = `namespace MethodParity;

public sealed class Closed {
    public int Plain() => 1;
}

public class OpenClass {
    public int Plain() => 1;
    public virtual int Extensible() => 2;
}

public interface IInherited {
    int Implemented();
    int Value { get; }
    int Stored { get; }
    int Mutable { get; set; }
}

public class InheritedBase {
    public int Implemented() => 7;
    public int Unused() => 8;
    public int Value => 9;
    public int Stored { get; set; }
    public int Mutable { get; set; }
}

public sealed class InheritedLeaf : InheritedBase, IInherited { }

public interface IGenericInherited<T> { T Data { get; } }
public class GenericSourceBase<T> { public T Data { get; set; } }
public sealed class GenericSourceLeaf : GenericSourceBase<int>, IGenericInherited<int> { }

public class GenericClrBase<T> {
    public T Current { get; set; }
    public bool MoveNext() => false;
    public void Reset() { }
    public void Dispose() { }
}
public sealed class GenericClrLeaf : GenericClrBase<int>, System.Collections.Generic.IEnumerator<int> {
    object System.Collections.IEnumerator.Current => 0;
}

public interface ISelected {
    int Chosen();
    int Token { get; }
}
public class ExplicitBase {
    public int Chosen() => 1;
    public int Token => 1;
}
public sealed class ExplicitLeaf : ExplicitBase, ISelected {
    int ISelected.Chosen() => 2;
    int ISelected.Token => 2;
}`

        private func EmitGSharp(source string = `package MethodParity

public class Closed {
    public func Plain() int32 { return 1 }
}

open class OpenClass {
    public func Plain() int32 { return 1 }
    open func Extensible() int32 { return 2 }
}

interface IInherited {
    func Implemented() int32;
    prop Value int32 { get; }
    prop Stored int32 { get; }
    prop Mutable int32 { get; set; }
}

open class InheritedBase {
    public func Implemented() int32 { return 7 }
    public func Unused() int32 { return 8 }
    public prop Value int32 -> 9
    public prop Stored int32 { get; set; }
    public prop Mutable int32 { get; set; }
}

class InheritedLeaf : InheritedBase, IInherited { }

interface IGenericInherited[T] { prop Data T { get; } }
open class GenericSourceBase[T] { public prop Data T { get; set; } }
class GenericSourceLeaf : GenericSourceBase[int32], IGenericInherited[int32] { }

open class GenericClrBase[T] {
    public prop Current T { get; set; }
    public func MoveNext() bool { return false }
    public func Reset() { }
    public func Dispose() { }
}
class GenericClrLeaf : GenericClrBase[int32], System.Collections.Generic.IEnumerator[int32] {
    prop (System.Collections.IEnumerator) Current object -> 0
}

interface ISelected {
    func Chosen() int32;
    prop Token int32 { get; }
}
open class ExplicitBase {
    public func Chosen() int32 { return 1 }
    public prop Token int32 -> 1
}
class ExplicitLeaf : ExplicitBase, ISelected {
    private func (ISelected) Chosen() int32 { return 2 }
    private prop (ISelected) Token int32 -> 2
}`, referenceAssembly bool = false)[]uint8 {
            using let stream = MemoryStream()
            using let referenceStream = MemoryStream()
            let tree = GSharpSyntaxTree.Parse(GSharpSourceText.From(source))
            let result = GSharpCompilation(tree).Emit(
                stream,
                if referenceAssembly {
                    referenceStream
                } else {
                    default(MemoryStream?)
                }
            )
            Assert.True(
                result.Success,
                "G# fixture should compile: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString())
                )
            )
            return if referenceAssembly {
                referenceStream.ToArray()
            } else {
                stream.ToArray()
            }
        }

        private func EmitCSharp()[]uint8 {
            using let stream = MemoryStream()
            let trustedAssemblies string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            let references = cast[[]?MetadataReference](
                trustedAssemblies
                    ?.Split(Path.PathSeparator)
                    .Where(File.Exists)
                    .Select((path string) -> MetadataReference.CreateFromFile(path))
                    .ToArray()
            ) ??
                [0]MetadataReference
            Assert.NotEmpty(references)
            let compilation = CSharpCompilation.Create(
                "MethodParity",
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(CSharpSource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(stream)
            Assert.True(
                result.Success,
                "C# fixture should compile: " + string.Join(
                    "; ",
                    result
                        .Diagnostics
                        .Where(
                        (d Microsoft.CodeAnalysis.Diagnostic) -> d.Severity == Microsoft
                            .CodeAnalysis
                            .DiagnosticSeverity
                            .Error
                    )
                        .Select((d Microsoft.CodeAnalysis.Diagnostic) -> d.ToString())
                )
            )
            return stream.ToArray()
        }

        private func FindMethod(image[]uint8, typeName string, methodName string) MethodAttributes {
            using let stream = MemoryStream(image)
            using let peReader = PEReader(stream)
            let metadata = peReader.GetMetadataReader()
            let type = metadata
                .TypeDefinitions
                .Select(metadata.GetTypeDefinition)
                .Single((definition TypeDefinition) -> metadata.GetString(definition.Name) == typeName)
            return type
                .GetMethods()
                .Select(metadata.GetMethodDefinition)
                .Single((method MethodDefinition) -> metadata.GetString(method.Name) == methodName)
                .Attributes
        }
    }
}
