package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.InteropServices
import System.Text.RegularExpressions
import Xunit

class Issue5264ImportedPInvokeDriverTests {
    @Theory
    @InlineData("DllImport")
    @InlineData("LibraryImport")
    func SeparateGSharpProducer_PInvokeSignaturesPreserveImportedValueTypes(attribute string) {
        using let fixture = CSharpFixture("public struct DirectoryOwner {}", assemblyName: "DirectoryOwner")
        let producer = Compile(fixture.DirectoryPath, "Fixture", Producer)
        Assert.Equal(0, producer.ExitCode)
        IlVerifier.Verify(producer.OutputPath)
        let source = `package Consumer
import Fixture
import System.Runtime.InteropServices
struct LocalParts { var Value uint32 }
struct Wrapper { var Value GuidParts }
@StructLayout(LayoutKind.Sequential)
class LocalClass { var Value uint32 }
@ATTRIBUTE("unused")
func Imported(ref value GuidParts);
@ATTRIBUTE("unused")
func Out(out value GuidParts);
@ATTRIBUTE("unused")
func In(in value GuidParts);
@ATTRIBUTE("unused")
func Value(value GuidParts) GuidParts;
@ATTRIBUTE("unused")
func Nested(ref value NestedParts);
@ATTRIBUTE("unused")
func Explicit(ref value ExplicitParts);
@ATTRIBUTE("unused")
func PointerField(ref value PointerNode);
@ATTRIBUTE("unused")
func Local(ref value LocalParts);
@ATTRIBUTE("unused")
func Wrapped(ref value Wrapper);
@ATTRIBUTE("unused")
func Override(@MarshalAs(UnmanagedType.Struct) ref value GuidParts);
@ATTRIBUTE("unused")
func Formatted(value LocalClass);
@DllImport("unused")
unsafe func Pointer(value *GuidParts) *GuidParts;
@DllImport("unused")
unsafe func PrimitivePointer(value *bool) *char;
@DllImport("unused")
unsafe func GenericPointer(value *GenericParts[uint32]) *GenericParts[uint32];`.Replace("ATTRIBUTE", attribute)
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, producer.OutputPath)
        Assert.True(consumer.ExitCode == 0, consumer.Diagnostics)
        IlVerifier.Verify(consumer.OutputPath, additionalReferences: []string{producer.OutputPath})
        let image = File.ReadAllBytes(consumer.OutputPath)
        Assert.NotEmpty(image)
        let repeated = Compile(fixture.DirectoryPath, "Consumer", source, producer.OutputPath)
        Assert.Equal(0, repeated.ExitCode)
        Assert.Equal(image, File.ReadAllBytes(repeated.OutputPath))

        let assembly = EmittedFixture.Load(consumer.OutputPath)
        let native = assembly
            .GetTypes()
            .SelectMany(
            (type Type) -> type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
        )
            .Where((method MethodInfo) -> (method.Attributes & MethodAttributes.PinvokeImpl) != 0)
            .ToArray()
        Assert.Equal(14, native.Length)
        let expected = []string{
            "Imported|System.Void|Fixture.GuidParts&",
            "Out|System.Void|Fixture.GuidParts&",
            "In|System.Void|Fixture.GuidParts&",
            "Value|Fixture.GuidParts|Fixture.GuidParts",
            "Nested|System.Void|Fixture.NestedParts&",
            "Explicit|System.Void|Fixture.ExplicitParts&",
            "PointerField|System.Void|Fixture.PointerNode&",
            "Local|System.Void|Consumer.LocalParts&",
            "Wrapped|System.Void|Consumer.Wrapper&",
            "Override|System.Void|Fixture.GuidParts&",
            "Formatted|System.Void|Consumer.LocalClass"
        }
        for signature in expected {
            let parts = signature.Split('|')
            let name = if attribute == "LibraryImport" {
                "<" + parts[0] + ">g__PInvoke|0_0"
            } else {
                parts[0]
            }
            let pointer = Assert.Single(native, (method MethodInfo) -> method.Name == "Pointer")
            Assert.Equal("Fixture.GuidParts*", Assert.Single(pointer.GetParameters()).ParameterType.FullName)
            Assert.Equal("Fixture.GuidParts*", pointer.ReturnType.FullName)
            let primitivePointer = Assert.Single(native, (method MethodInfo) -> method.Name == "PrimitivePointer")
            Assert.Equal(typeof(bool).MakePointerType(), Assert.Single(primitivePointer.GetParameters()).ParameterType)
            Assert.Equal(typeof(char).MakePointerType(), primitivePointer.ReturnType)
            let genericPointer = Assert.Single(native, (method MethodInfo) -> method.Name == "GenericPointer")
            let parameterType = Assert.Single(genericPointer.GetParameters()).ParameterType
            Assert.True(parameterType.IsPointer)
            Assert.Equal(parameterType, genericPointer.ReturnType)
            Assert.Equal("Fixture.GenericParts`1", parameterType.GetElementType()!!.GetGenericTypeDefinition().FullName)
            Assert.Equal(typeof(uint32), Assert.Single(parameterType.GetElementType()!!.GetGenericArguments()))
            let method = Assert.Single(native, (candidate MethodInfo) -> candidate.Name == name)
            Assert.Equal(parts[1], method.ReturnType.FullName)
            let parameter = Assert.Single(method.GetParameters())
            Assert.Equal(parts[2], parameter.ParameterType.FullName)
            let dllImport = method.GetCustomAttribute[DllImportAttribute]()
            Assert.NotNull(dllImport)
            Assert.Equal("unused", dllImport.Value)
            Assert.Equal(parts[0], dllImport.EntryPoint)
            if parts[2].StartsWith("Fixture.", StringComparison.Ordinal) {
                let valueType = if parameter.ParameterType.IsByRef {
                    parameter.ParameterType.GetElementType()!!
                } else {
                    parameter.ParameterType
                }
                Assert.Equal("Fixture", valueType.Assembly.GetName().Name)
                Assert.True(valueType.IsValueType)
            }
        }
        let imported = assembly
            .GetTypes()
            .SelectMany(
            (type Type) -> type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
        )
            .Single((method MethodInfo) -> method.Name == "Imported")
        let guidParts = Assert.Single(imported.GetParameters()).ParameterType.GetElementType()!!
        Assert.True(guidParts.IsLayoutSequential)
        Assert.Equal(16, Marshal.SizeOf(guidParts))
        Assert.Equal(
            []string{"A", "B", "C", "D"},
            guidParts.GetFields().Select((field FieldInfo) -> field.Name).ToArray()
        )
        Assert.All(guidParts.GetFields(), (field FieldInfo) -> Assert.Equal(typeof(uint32), field.FieldType))
    }

    @Theory
    @InlineData("DllImport")
    @InlineData("LibraryImport")
    func ManagedAndUnsupportedLayouts_AreRejectedAtEverySignaturePosition(attribute string) {
        using let fixture = CSharpFixture(Contract)
        var source = "package Consumer\nimport Contracts\nimport System.Runtime.InteropServices\n" +
            "@StructLayout(LayoutKind.Sequential)\nclass LocalClass { var Value uint32 }\n" +
            "struct LocalReference { var Value LocalClass }\nstruct LocalGeneric[T] { var Value T }\n"
        let expected = List[string]()
        var line = 8
        var index = 0
        for type in[]string{
            "Managed",
            "NestedManaged",
            "Auto",
            "Bool",
            "Char",
            "Decimal",
            "Optional",
            "RefLike",
            "Generic[int32]",
            "LocalGeneric[int32]",
            "LocalReference",
            "LocalClass",
            "Formatted",
            "int32?"
        } {
            for position in[]string{"ref", "out", "in", "value", "return"} {
                if type == "LocalClass" && position == "value" {
                    continue
                }
                let declaration = if position == "return" {
                    "func Rejected" + index.ToString() + "() " + type + ";"
                } else {
                    "func Rejected" + index.ToString() +
                        "(" +
                        (
                        if position == "value" {
                            ""
                        } else {
                            position + " "
                        }
                    ) +
                        "value " +
                        type +
                        ");"
                }
                let unsupported = type == "Formatted" ||
                    type == "int32?" ||
                    type == "LocalClass" ||
                    type == "Generic[int32]" ||
                    type == "LocalGeneric[int32]"
                let id = if type == "LocalClass" && position == "return" {
                    "GS0351"
                } else if unsupported {
                    if position == "value" || position == "return" {
                        "GS0323"
                    } else {
                        "GS0352"
                    }
                } else {
                    "GS0349"
                }
                source += "@" + attribute + "(\"unused\")\n" + declaration + "\n"
                let column = declaration.LastIndexOf(type, StringComparison.Ordinal) + 1
                expected.Add(
                    "Consumer.gs(" + (line + 1).ToString() + "," + column.ToString() + "," + (line + 1).ToString() +
                        "," +
                        (column + type.Length).ToString() + "): error " + id + ":"
                )
                line += 2
                index++
            }
        }
        let rejected = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.NotEqual(0, rejected.ExitCode)
        Assert.False(File.Exists(rejected.OutputPath), rejected.Diagnostics)
        let diagnostics = Regex
            .Matches(rejected.Diagnostics, "Consumer\\.gs\\([0-9]+,[0-9]+,[0-9]+,[0-9]+\\): error GS[0-9]+:")
            .Select((match Match) -> match.Value)
            .ToArray()
        Assert.Equal(69, diagnostics.Length)
        Assert.Equal(expected.ToArray(), diagnostics)
    }

    @Fact
    func SymbolicImportedFields_UseActualArgumentsAndKeepUnmanagedDistinctFromBlittable() {
        using let fixture = CSharpFixture(Contract)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let detector = BlittableDetector()
        Assert.True(resolver.TryResolveType("Contracts.Plain", out var plain))
        let plainSymbol = TypeSymbol.FromClrTypeWithoutNullability(plain, NullabilityFreeReason.TypeStructure)
        Assert.True(PInvokeBinder.IsSupportedMarshallingType(plainSymbol))
        Assert.True(PInvokeBinder.IsSupportedMarshallingType(ByRefTypeSymbol.Get(plainSymbol)))
        for name in[]string{"Contracts.Generic`1", "Contracts.NestedGeneric`1"} {
            Assert.True(resolver.TryResolveType(name, out var definition))
            Assert.False(
                detector.IsBlittable(
                    TypeSymbol.FromClrTypeWithoutNullability(definition, NullabilityFreeReason.TypeStructure)
                )
            )
            for erasedArgument in[]Type{typeof(int32), typeof(string)} {
                let erased = definition.MakeGenericType(resolver.MapClrTypeToReferences(erasedArgument))
                for fieldType in[]TypeSymbol{
                    TypeSymbol.UInt32,
                    TypeSymbol.Bool,
                    TypeSymbol.Char,
                    TypeSymbol.Decimal,
                    TypeSymbol.String
                } {
                    let local = StructSymbol(
                        "Local",
                        ImmutableArray.Create(FieldSymbol("Value", fieldType, Accessibility.Public, false)),
                        Accessibility.Public,
                        nil,
                        "Consumer"
                    )
                    let symbolic = ImportedTypeSymbol.GetConstructed(
                        erased,
                        definition,
                        ImmutableArray.Create[TypeSymbol](local)
                    )
                    let expectedBlittable = fieldType == TypeSymbol.UInt32
                    let expectedUnmanaged = fieldType != TypeSymbol.String
                    Assert.Equal(expectedBlittable, detector.IsBlittable(symbolic))
                    Assert.Equal(expectedBlittable, BlittableDetector.IsBlittableValueStructPointee(symbolic))
                    Assert.Equal(expectedUnmanaged, detector.IsUnmanaged(symbolic))
                    Assert.False(PInvokeBinder.IsSupportedMarshallingType(symbolic))
                    Assert.False(PInvokeBinder.IsSupportedMarshallingType(ByRefTypeSymbol.Get(symbolic)))
                    Assert.Equal(
                        expectedBlittable,
                        PInvokeBinder.IsSupportedMarshallingType(PointerTypeSymbol.Get(symbolic))
                    )
                }
            }
        }
        Assert.True(resolver.TryResolveType("Contracts.Auto", out var auto))
        let autoSymbol = TypeSymbol.FromClrTypeWithoutNullability(auto, NullabilityFreeReason.TypeStructure)
        Assert.False(detector.IsBlittable(autoSymbol))
        Assert.True(detector.IsUnmanaged(autoSymbol))
        let managedReference = ByRefTypeSymbol.Get(TypeSymbol.UInt32)
        Assert.False(detector.IsBlittable(managedReference))
        Assert.False(detector.IsUnmanaged(managedReference))
        let callback = FunctionPointerTypeSymbol.Get(
            CallingConvention.Cdecl,
            ImmutableArray[TypeSymbol].Empty,
            TypeSymbol.Void
        )
        Assert.True(detector.IsBlittable(callback))
        Assert.True(detector.IsUnmanaged(callback))
        let recursive = StructSymbol(
            "Recursive",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            nil,
            "Consumer"
        )
        recursive.SetInstanceFieldsAndPrimaryConstructorParameters(
            ImmutableArray.Create(FieldSymbol("Value", recursive, Accessibility.Public)),
            ImmutableArray[ParameterSymbol].Empty
        )
        Assert.False(detector.IsBlittable(recursive))
        Assert.False(detector.IsUnmanaged(recursive))
        let autoLocal = StructSymbol("Auto", ImmutableArray[FieldSymbol].Empty, Accessibility.Public, nil, "Consumer")
        autoLocal.SetLayoutMetadata(StructLayoutMetadata(LayoutKind.Auto, nil, nil))
        Assert.False(detector.IsBlittable(autoLocal))
        Assert.True(detector.IsUnmanaged(autoLocal))
    }

    shared {
        private const Producer string = `package Fixture
import System.Runtime.InteropServices
@StructLayout(LayoutKind.Sequential)
public struct GuidParts {
    public var A uint32
    public var B uint32
    public var C uint32
    public var D uint32
}
public struct NestedParts { public var Value GuidParts }
public struct GenericParts[T] { public var Value T }
@StructLayout(LayoutKind.Explicit, Size: 16)
public struct ExplicitParts {
    @FieldOffset(0) public var Value GuidParts
}
public unsafe struct PointerNode {
    public var Value uint32
    public var Next *PointerNode
}`

        private const Contract string = `using System.Runtime.InteropServices;
namespace Contracts {
    public struct Plain { public uint Value; }
    public struct Managed { private string value; }
    public struct NestedManaged { public Managed Value; }
    [StructLayout(LayoutKind.Auto)] public struct Auto { public uint Value; }
    public struct Bool { public bool Value; }
    public struct Char { public char Value; }
    public struct Decimal { public decimal Value; }
    public struct Optional { public int? Value; }
    public ref struct RefLike { public uint Value; }
    public struct Generic<T> { public T Value; public static string Ignored; }
    public struct NestedGeneric<T> { public Generic<T> Value; }
    [StructLayout(LayoutKind.Sequential)] public class Formatted { public uint Value; }
}`

        private func Compile(directory string, name string, source string, reference string? = nil)(
            ExitCode int32,
            Diagnostics string,
            OutputPath string
        ) {
            let sourcePath = Path.Combine(directory, name + ".gs")
            let outputPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            let arguments = List[string]{
                "/target:library",
                "/targetframework:net10.0",
                "/deterministic+",
                "/debug:none",
                "/out:" + outputPath,
                sourcePath
            }
            if reference != nil {
                arguments.Add("/reference:" + reference)
            }
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let originalOut = Console.Out
            let originalError = Console.Error
            var exitCode int32
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                exitCode = Program.Main(arguments.ToArray())
            } finally {
                Console.SetOut(originalOut)
                Console.SetError(originalError)
            }
            return (exitCode, stdout.ToString() + stderr.ToString(), outputPath)
        }
    }
}
