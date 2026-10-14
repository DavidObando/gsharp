// <copyright file="Issue4601TransitiveClrInterfaceImplEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Issue #4601: a G# type that lists an imported CLR interface must also list
/// that interface's base interfaces in its `InterfaceImpl` table, as csc
/// does.
/// @remarks <b>The miscompile.</b> The CLR re-maps only the interfaces a type
/// itself lists. gsc emitted a row for the declared interface alone, so for
/// `class Derived : Base, IDerivedI`, where the imported `Base`
/// already implements `IBaseI` (the base of `IDerivedI`), the
/// `IBaseI` slots kept `Base`'s mapping. A member `Derived`
/// declared for an `IBaseI` slot was silently ignored by interface
/// dispatch: the program compiled without a diagnostic and ran the base
/// class's member. The same C# program dispatches to the derived member.
///
/// <b>The fix.</b> `ReflectionMetadataEmitter.EmitInterfaceImplRows`
/// follows each declared CLR interface with its transitive base interfaces,
/// de-duplicated together with the #985 bridge rows. G#-declared interfaces
/// were already closed at bind time (#1006).
///
/// <b>Discrimination witness (ADR-0154).</b> Reverting
/// `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` to its
/// parent state fails every `ReListedInterface_DispatchesToTheDerivedMember`
/// row (the base class's value is printed) and every
/// `EmittedInterfaceRows_AreTheTransitiveClosure` row (base rows missing),
/// and leaves every `AGreenNeighbour_KeepsItsDispatch` row passing.
open class Issue4601TransitiveClrInterfaceImplEmitTests {
    /// A member for a base-interface slot now wins interface dispatch.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("MisdispatchedCases")
    func ReListedInterface_DispatchesToTheDerivedMember(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    /// Shapes that already dispatched correctly keep doing so.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("GreenNeighbours")
    func AGreenNeighbour_KeepsItsDispatch(name string, source string, expectedLines[]string) -> CompileVerifyAndRun(
        name,
        source,
        expectedLines
    )

    /// The emitted rows are exactly the transitive closure, without duplicates.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param typeName The metadata name of the type to inspect.
    /// @param expectedRows The expected interface rows, in any order.
    @Theory
    @MemberData("RowCases")
    func EmittedInterfaceRows_AreTheTransitiveClosure(
        name string,
        source string,
        typeName string,
        expectedRows[]string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4601_rows_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let log = Compile(tempDir, "Lib.gs", source, appPath, "/target:library", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$log"))
            let rows = ReadInterfaceRows(appPath, typeName)
            Assert.Equal(expectedRows.Length, rows.Count)
            Assert.Equal(
                expectedRows.OrderBy((r string) -> r, StringComparer.Ordinal),
                rows.OrderBy((r string) -> r, StringComparer.Ordinal)
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Two referenced assemblies that each define a `Shared.IBase`: the
    /// two base interfaces have the same full name but are different types,
    /// so both rows must be emitted (a full-name comparison would drop one).
    @Fact
    func SameNamedBaseInterfacesFromTwoAssemblies_KeepBothRows() {
        const TwinSource = `namespace Shared { public interface IBase { int V(); } }
namespace NAME { public interface IFACE : Shared.IBase { } public static class Probe { public static int V(Shared.IBase b) => b.V(); } }`
        let tempDir = Directory.CreateTempSubdirectory("gs_4601_twins_").FullName
        try {
            let one = CompileCSharpLibrary(tempDir, "TwinOne", TwinSource.Replace("NAME", "One").Replace("IFACE", "IA"))
            let two = CompileCSharpLibrary(tempDir, "TwinTwo", TwinSource.Replace("NAME", "Two").Replace("IFACE", "IB"))
            let appPath = Path.Combine(tempDir, "twins.dll")
            let log = Compile(tempDir, "App.gs", `package P
import System

class C : One.IA, Two.IB {
    func V() int32 { return 5 }
}

Console.WriteLine(One.Probe.V(C()))
Console.WriteLine(Two.Probe.V(C()))`, appPath, "/target:exe", "/reference:" + one, "/reference:" + two)
            Assert.DoesNotContain(" error ", log, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), (`must compile. Log:
` + "$log"))
            {
                using let stream = File.OpenRead(appPath)
                {
                    using let peReader = PEReader(stream)
                    let reader = peReader.GetMetadataReader()
                    let type = reader
                        .TypeDefinitions
                        .Select(reader.GetTypeDefinition)
                        .Single((t TypeDefinition) -> reader.GetString(t.Name) == "C")
                    let baseScopes = List[string]()
                    for implHandle in type.GetInterfaceImplementations() {
                        let iface = reader.GetInterfaceImplementation(implHandle).Interface
                        if iface.Kind == HandleKind.TypeReference {
                            let typeRef = reader.GetTypeReference(TypeReferenceHandle(iface))
                            if reader.GetString(typeRef.Name) == "IBase" &&
                                typeRef
                                .ResolutionScope
                                .Kind == HandleKind
                                .AssemblyReference {
                                let scope_ = reader.GetAssemblyReference(
                                    AssemblyReferenceHandle(typeRef.ResolutionScope)
                                )
                                baseScopes.Add(reader.GetString(scope_.Name))
                            }
                        }
                    }
                    Assert.Equal(
                        []string{"TwinOne", "TwinTwo"},
                        baseScopes.OrderBy((n string) -> n, StringComparer.Ordinal)
                    )
                }
            }
            IlVerifier.Verify(appPath, []string{one, two})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal(
                []string{"5", "5"},
                output.Split('\n').Select((l string) -> l.TrimEnd('\r')).Where((l string) -> l.Length > 0).ToArray()
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Renders a TypeSpec as `Name`N<Arg,...>`.
    private class RowNameProvider : ISignatureTypeProvider[string, object] {
        func GetArrayType(elementType string, shape ArrayShape) string -> elementType + "[,]"

        func GetByReferenceType(elementType string) string -> elementType + "&"

        func GetFunctionPointerType(signature MethodSignature[string]) string -> "fnptr"

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "<" +
            string.Join(",", typeArguments) + ">"

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString()

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString()

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType

        func GetPinnedType(elementType string) string -> elementType

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()

        func GetSZArrayType(elementType string) string -> elementType + "[]"

        func GetTypeFromDefinition(
            reader MetadataReader,
            handle TypeDefinitionHandle,
            rawTypeKind uint8
        ) string -> reader.GetString(reader.GetTypeDefinition(handle).Name)

        func GetTypeFromReference(
            reader MetadataReader,
            handle TypeReferenceHandle,
            rawTypeKind uint8
        ) string -> reader.GetString(reader.GetTypeReference(handle).Name)

        func GetTypeFromSpecification(
            reader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> reader
            .GetTypeSpecification(handle).DecodeSignature(this, genericContext)
    }

    shared {
        private const RunTimeout int32 = 60_000

        private const LibrarySource string = `namespace Clib;

public interface IBaseI { int Value { get; } }
public interface IDerivedI : IBaseI { }
public class Base : IBaseI { public int Value => 1; }
public class ExplicitBase : IBaseI { int IBaseI.Value => 10; }

public interface IM { int M(); }
public interface IM2 : IM { }
public class BaseM : IM { public int M() => 1; }

public interface IA { int A(); }
public interface IB : IA { }
public interface IC : IA { }
public interface ID : IB, IC { }
public class BaseD : ID { public int A() => 1; }

public interface IG<T> { T Get(); }
public interface IG2<T> : IG<T> { }
public class BaseG<T> : IG<T> { public T Get() => default!; }

public interface IMark<T> { }
public interface IMark2<T> : IMark<T> { }

public static class Probe
{
    public static bool Is<T>(object o) => o is IMark<T>;
    public static int Read(IBaseI x) => x.Value;
    public static int M(IM x) => x.M();
    public static int A(IA x) => x.A();
    public static string G(IG<string> x) => x.Get() ?? "null";
}`

        /// Shapes whose dispatch was wrong before the fix: a member declared for a
        /// base-interface slot that the imported base class already implements.
        /// @returns Case name, G# source, expected stdout lines.
        func MisdispatchedCases() sequence[[]object] {
            // The issue's repro: an implicit property for `IBaseI.Value`.
            yield[]object{"implicit-property-over-imported-base", `package P
import System
import Clib

class Derived : Base, IDerivedI {
    prop Value int32 { get { return 2 } }
}

Console.WriteLine(Probe.Read(Derived()))
Console.WriteLine(Derived().Value)`, []string{"2", "2"}}
            // A diamond: `ID : IB, IC`, both over `IA`.
            yield[]object{"diamond-base-interfaces", `package P
import System
import Clib

class DD : BaseD, ID {
    func A() int32 { return 4 }
}

Console.WriteLine(Probe.A(DD()))`, []string{"4"}}
            // A generic interface closed over a CLR type.
            yield[]object{"generic-interface-over-imported-generic-base", `package P
import System
import Clib

class GG : BaseG[string], IG2[string] {
    func Get() string { return "gg" }
}

Console.WriteLine(Probe.G(GG()))`, []string{"gg"}}
            // The BCL shape from the issue: `IList[int32]` re-listed over
            // `Collection[int32]`, member for the `ICollection[int32]` slot.
            yield[]object{"bcl-ilist-over-collection", `package P
import System
import System.Collections.Generic
import System.Collections.ObjectModel

class Coll : Collection[int32], IList[int32] {
    prop IsReadOnly bool { get { return true } }
}

Console.WriteLine((Coll() as ICollection[int32])!!.IsReadOnly)`, []string{"True"}}
        }

        /// Neighbours whose dispatch was already right and must stay so.
        /// @returns Case name, G# source, expected stdout lines.
        func GreenNeighbours() sequence[[]object] {
            // The negative control: re-listing `IDerivedI` without declaring a
            // member keeps the imported base's EXPLICIT implementation. The added
            // `IBaseI` row must not steal that mapping.
            yield[]object{"no-member-keeps-the-base-explicit-implementation", `package P
import System
import Clib

class NoMember : ExplicitBase, IDerivedI {
}

Console.WriteLine(Probe.Read(NoMember()))`, []string{"10"}}
            // An explicit implementation of a base-interface slot. The #985
            // bridge already emitted the explicit target's row before the fix.
            yield[]object{"explicit-implementation-of-a-base-interface-slot", `package P
import System
import Clib

class DX : BaseM, IM2 {
    func (IM) M() int32 { return 3 }
}

Console.WriteLine(Probe.M(DX()))`, []string{"3"}}
            // Two same-named G# types (`Shape`, `Outer.Shape`) as arguments of one
            // generic interface: the rows de-duplicate on the TypeSpec signature,
            // never on a display name that would conflate them and drop a row.
            yield[]object{"same-named-type-arguments-keep-their-rows", `package P
import System
import Clib

class Shape { }
class Outer {
    class Shape { }
}
class X : IMark2[Shape], IMark2[Outer.Shape] { }
class Y : IMark2[Shape], IMark[Outer.Shape] { }

Console.WriteLine(Probe.Is[Shape](X()))
Console.WriteLine(Probe.Is[Outer.Shape](X()))
Console.WriteLine(Probe.Is[Outer.Shape](Y()))`, []string{"True", "True", "True"}}
            // Two closed instantiations of one generic interface: neither row may
            // be lost to de-duplication.
            yield[]object{"two-instantiations-of-one-interface", `package P
import System

class Two : IComparable[int32], IComparable[string] {
    func CompareTo(other int32) int32 { return 1 }
    func CompareTo(other string) int32 { return 2 }
}

Console.WriteLine((Two() as IComparable[int32])!!.CompareTo(0))
Console.WriteLine((Two() as IComparable[string])!!.CompareTo("x"))`, []string{"1", "2"}}
        }

        /// Exact `InterfaceImpl` row sets, read from metadata (reflection's
        /// `GetInterfaces` computes the closure itself and cannot tell).
        /// @returns Case name, G# source, type name, expected rows.
        func RowCases() sequence[[]object] {
            yield[]object{"concrete-bcl-interface", `package P
import System
import System.Collections.Generic
import System.Collections.ObjectModel

class Coll : Collection[int32], IList[int32] {
    prop IsReadOnly bool { get { return true } }
}`, "Coll", []string{"IList`1<Int32>", "ICollection`1<Int32>", "IEnumerable`1<Int32>", "IEnumerable"}}
            // A symbolic argument (a same-compilation class), with the #985
            // non-generic bridge: the bridge's `IEnumerable` and the closure's
            // must collapse to one row.
            yield[]object{"symbolic-argument-with-bridge", `package P
import System
import System.Collections
import System.Collections.Generic

class Shape {
}

class RC : IReadOnlyCollection[Shape] {
    private let _items List[Shape] = List[Shape]()
    prop Count int32 { get { return 0 } }
    func GetEnumerator() IEnumerator[Shape] { return _items.GetEnumerator() }
    private func GetEnumerator() IEnumerator { return GetEnumerator() }
}`, "RC", []string{"IReadOnlyCollection`1<Shape>", "IEnumerable`1<Shape>", "IEnumerable"}}
            // A class type parameter as the argument.
            yield[]object{"type-parameter-argument", `package P
import System
import Clib

class Box[T] : IG2[T] {
    func Get() T { return default(T) }
}`, "Box`1", []string{"IG2`1<!0>", "IG`1<!0>"}}
            // Same-named argument types stay distinct rows.
            yield[]object{"same-named-type-arguments", `package P
import System
import Clib

class Shape { }
class Outer {
    class Shape { }
}
class X : IMark2[Shape], IMark2[Outer.Shape] { }`, "X", []string{
                    "IMark2`1<Shape>",
                    "IMark`1<Shape>",
                    "IMark2`1<Shape>",
                    "IMark`1<Shape>"
                }}
            // A diamond lists the shared base once.
            yield[]object{"diamond", `package P
import System
import Clib

class DD : BaseD, ID {
    func A() int32 { return 4 }
}`, "DD", []string{"ID", "IB", "IA", "IC"}}
        }

        private func ReadInterfaceRows(assemblyPath string, typeName string) List[string] {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let provider = RowNameProvider()
            for handle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(handle)
                if reader.GetString(type.Name) != typeName {
                    continue
                }
                let rows = List[string]()
                for implHandle in type.GetInterfaceImplementations() {
                    let iface = reader.GetInterfaceImplementation(implHandle).Interface
                    rows.Add(
                        switch iface.Kind {
                            case HandleKind.TypeDefinition: reader.GetString(
                                reader.GetTypeDefinition(TypeDefinitionHandle(iface)).Name
                            )
                            case HandleKind.TypeReference: reader.GetString(
                                reader.GetTypeReference(TypeReferenceHandle(iface)).Name
                            )
                            case HandleKind.TypeSpecification: reader.GetTypeSpecification(
                                TypeSpecificationHandle(iface)
                            )
                                .DecodeSignature(provider, nil)
                            default: iface.Kind.ToString()
                        }
                    )
                }
                return rows
            }
            throw InvalidOperationException("type '$typeName' not found in $assemblyPath")
        }

        private func CompileVerifyAndRun(name string, source string, expectedLines[]string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4601_").FullName
            try {
                let libPath = CompileCSharpLibrary(tempDir)
                let appPath = Path.Combine(tempDir, name + ".dll")
                let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
                Assert.DoesNotContain(" error ", log, StringComparison.Ordinal)
                Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$log"))
                IlVerifier.Verify(appPath, []string{libPath})
                let (exit, output) = RunDotnet(appPath)
                Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
                let lines = output
                    .Split('\n')
                    .Select((line string) -> line.TrimEnd('\r'))
                    .Where((line string) -> line.Length > 0)
                    .ToArray()
                Assert.Equal(expectedLines, lines)
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func CompileCSharpLibrary(tempDir string) string -> CompileCSharpLibrary(tempDir, "Clib", LibrarySource)

        private func CompileCSharpLibrary(tempDir string, assemblyName string, source string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, assemblyName + ".dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(tpa) {
                Enumerable.Empty[string]()
            } else {
                tpa!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }
    }
}
