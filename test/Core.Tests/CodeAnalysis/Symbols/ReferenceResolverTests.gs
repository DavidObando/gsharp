// <copyright file="ReferenceResolverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Buffers.Binary
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.PortableExecutable
import Xunit

/// Tests for (cref:ReferenceResolver), the seam that `import`
/// statements use to resolve CLR types.
open class ReferenceResolverTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func DuplicateAssemblyNames_KeepTheWinningImageVersionAndOriginalPath(reverse bool) {
        using let first = CSharpFixture(
            "[assembly: System.Reflection.AssemblyVersion(\"1.0.0.0\")]\npublic class First5421 {}",
            assemblyName: "Duplicate5421"
        )
        using let second = CSharpFixture(
            "[assembly: System.Reflection.AssemblyVersion(\"2.0.0.0\")]\npublic class Second5421 {}",
            assemblyName: "Duplicate5421"
        )
        let winner = if reverse {
            second.AssemblyPath
        } else {
            first.AssemblyPath
        }
        let loser = if reverse {
            first.AssemblyPath
        } else {
            second.AssemblyPath
        }
        using let resolver = ReferenceResolver.WithReferences([]string{winner, loser})
        Assert.True(
            resolver.TryResolveType(
                if reverse {
                    "Second5421"
                } else {
                    "First5421"
                },
                out var type
            )
        )
        Assert.False(
            resolver.TryResolveType(
                if reverse {
                    "First5421"
                } else {
                    "Second5421"
                },
                out _
            )
        )
        Assert.Equal(
            Version(
                if reverse {
                    2
                } else {
                    1
                },
                0,
                0,
                0
            ),
            type.Assembly.GetName().Version
        )
        Assert.True(ReferenceResolver.TryGetAssemblyPath(type.Assembly, out var path))
        Assert.Equal(winner, path)
    }

    @Theory
    @InlineData("System.Console")
    @InlineData("System.String")
    func Default_Resolves_Bcl_Type(fullName string) {
        let resolver = ReferenceResolver.Default()
        Assert.True(resolver.TryResolveType(fullName, out var type))
        Assert.Equal(fullName, type.FullName)
    }

    @Fact
    func Default_Returns_False_For_Unknown_Type() {
        let resolver = ReferenceResolver.Default()
        Assert.False(resolver.TryResolveType("System.ThisTypeDoesNotExist", out var type))
        Assert.Null(type)
    }

    @Fact
    func Default_Reuses_TypeNameIndex_WhileHostAssembliesAreUnchanged() {
        let first = ReferenceResolver.Default()
        let second = ReferenceResolver.Default()
        let indexField FieldInfo? = typeof(ReferenceResolver).GetField(
            "typeNameIndex",
            BindingFlags.Instance | BindingFlags.NonPublic
        )
        Assert.NotNull(indexField)
        Assert.Equal(
            first.Assemblies.Select((assembly Assembly) -> assembly.GetName().FullName),
            second.Assemblies.Select((assembly Assembly) -> assembly.GetName().FullName)
        )
        Assert.Same(indexField!!.GetValue(first), indexField!!.GetValue(second))
    }

    @Fact
    func WithReferences_Resolves_Type_From_Supplied_Assembly() {
        let corePath = typeof(ReferenceResolver).Assembly.Location
        Assert.False(string.IsNullOrEmpty(corePath))
        let resolver = ReferenceResolver.WithReferences([]string{corePath})
        Assert.True(resolver.TryResolveType("GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver", out var type))
        Assert.Equal(typeof(ReferenceResolver).FullName, type.FullName)
    }

    @Theory
    @InlineData("System.Object")
    @InlineData("System.IO.Stream")
    @InlineData("System.Text.Encoding")
    func WithReferences_Resolves_NetStandard20_Core_Types(fullName string) {
        let referenceDirectory string? = typeof(ReferenceResolverTests)
            .Assembly
            .GetCustomAttributes[AssemblyMetadataAttribute]()
            .Single((attribute AssemblyMetadataAttribute) -> attribute.Key == "NetStandard20ReferenceDirectory")
            .Value
        Assert.True(Directory.Exists(referenceDirectory))
        using let resolver = ReferenceResolver.WithReferences(Directory.EnumerateFiles(referenceDirectory!!, "*.dll"))
        Assert.True(resolver.TryResolveType(fullName, out var type))
        Assert.Equal("netstandard", type.Assembly.GetName().Name)
    }

    @Fact
    func WithReferences_Ignores_Native_PE_With_Core_Assembly_Name() {
        let directory = Path.Combine(AppContext.BaseDirectory, "reference-resolver-3594", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let path = Path.Combine(directory, "System.Runtime.dll")
            File.WriteAllBytes(path, CreateNativePeImage())
            using let resolver = ReferenceResolver.WithReferences([]string{path})
            Assert.Empty(resolver.Assemblies)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// An `internal` (non-externally-visible) type declared by a referenced
    /// assembly that does not grant this compilation friendship must not satisfy
    /// a type reference by name — matching C# accessibility. Regression for the
    /// bug where an unqualified `ThisAssembly` bound to the framework-internal
    /// `System.Diagnostics.ThisAssembly` (whose `AssemblyFileVersion` is a
    /// (cref:System.Version)) instead of failing to resolve.
    @Fact
    func WithReferences_Does_Not_Resolve_Internal_Type_By_Name() {
        let asm = typeof(DiagnosticSource).Assembly
        let path = asm.Location
        Assert.False(string.IsNullOrEmpty(path))
        // Any top-level internal type the assembly actually declares.
        let internalType Type? = asm.GetTypes().FirstOrDefault(
            (t Type) -> t.IsNotPublic && !t.IsNested && t.FullName != nil
        )
        Assert.NotNull(internalType)
        let resolver = ReferenceResolver.WithReferences([]string{path})
        // CurrentAssemblyName is unset, so no InternalsVisibleTo friendship is
        // granted and the internal type is unreachable by name.
        Assert.False(resolver.TryResolveType(internalType!!.FullName!!, out var resolved))
        Assert.Null(resolved)
        // A public type in the same assembly still resolves — the accessibility
        // gate must not over-block externally visible types.
        Assert.True(resolver.TryResolveType(typeof(DiagnosticSource).FullName!!, out _))
    }

    @Fact
    func TryResolveType_WithoutExternalVisibility_Resolves_Internal_Type_By_Name() {
        // The emitter/lowering infrastructure resolves well-known types by exact
        // name — including compiler-internal attributes such as NullableAttribute
        // / IsReadOnlyAttribute — and must be able to bypass the accessibility
        // gate that guards user-written type references. Regression guard: a too-
        // aggressive gate dropped these lookups, silently stripping nullable /
        // readonly metadata from emitted assemblies.
        let asm = typeof(DiagnosticSource).Assembly
        let path = asm.Location
        Assert.False(string.IsNullOrEmpty(path))
        let internalType Type? = asm.GetTypes().FirstOrDefault(
            (t Type) -> t.IsNotPublic && !t.IsNested && t.FullName != nil
        )
        Assert.NotNull(internalType)
        let resolver = ReferenceResolver.WithReferences([]string{path})
        // Gated (user-facing) path: internal type is unreachable by name.
        Assert.False(resolver.TryResolveType(internalType!!.FullName!!, out _))
        // Ungated (infrastructure) path: the same internal type resolves.
        Assert.True(
            resolver.TryResolveType(internalType!!.FullName!!, requireExternalVisibility: false, out var resolved)
        )
        Assert.NotNull(resolved)
        Assert.Equal(internalType!!.FullName, resolved.FullName)
        // The bypass overload still resolves externally visible types.
        Assert.True(
            resolver.TryResolveType(typeof(DiagnosticSource).FullName!!, requireExternalVisibility: false, out _)
        )
    }

    @Fact
    func TryResolveType_SkipsInternalDuplicateForPublicType() {
        let directory = Path.Combine(AppContext.BaseDirectory, "reference-resolver-3445", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let internalPath = EmitCollisionAssembly(directory, "InternalAttributeShim", "internal")
            let publicPath = EmitCollisionAssembly(directory, "PublicFrameworkType", "public")
            using let resolver = ReferenceResolver.WithReferences([]string{internalPath, publicPath})
            // Issue #4233: infrastructure's ungated lookup (`false`) exists so
            // genuinely internal-only well-known types (no public alternative
            // anywhere in the reference set, e.g. IsReadOnlyAttribute) still
            // resolve — see TryResolveType_WithoutExternalVisibility_Resolves_
            // Internal_Type_By_Name. It must NOT prefer an inaccessible shim
            // over an accessible duplicate when one exists: gsc previously
            // emitted a TypeRef into Microsoft.TestPlatform.Utilities' private
            // System.Diagnostics.CodeAnalysis.NotNullWhenAttribute polyfill
            // instead of the public framework type, and the CLR rejected the
            // resulting IL with MethodAccessException despite a clean compile.
            Assert.True(
                resolver.TryResolveType(
                    "ResolverCollision3445.MarkerAttribute",
                    requireExternalVisibility: false,
                    out var raw
                )
            )
            Assert.True(raw.IsPublic)
            Assert.Equal("PublicFrameworkType", raw.Assembly.GetName().Name)
            Assert.True(resolver.TryResolveType("ResolverCollision3445.MarkerAttribute", out var resolved))
            Assert.True(resolved.IsPublic)
            Assert.Equal("PublicFrameworkType", resolved.Assembly.GetName().Name)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func WithReferences_Tolerates_Null_Or_Missing_Paths() {
        let resolver = ReferenceResolver.WithReferences([]string{string.Empty, "/this/path/does/not/exist.dll"})
        Assert.True(resolver.TryResolveType("System.Console", out _))
    }

    @Fact
    func Default_MapClrTypeToReferences_Returns_Host_Type_Unchanged() {
        let resolver = ReferenceResolver.Default()
        // With no MetadataLoadContext the host type already has the right
        // identity, so the projection is a no-op (reference-equal).
        Assert.Same(typeof(int32), resolver.MapClrTypeToReferences(typeof(int32)))
        Assert.Same(typeof(string), resolver.MapClrTypeToReferences(typeof(string)))
        Assert.Null(resolver.MapClrTypeToReferences(nil))
    }

    @Theory
    @InlineData(typeof(int32))
    @InlineData(typeof(bool))
    @InlineData(typeof(float64))
    @InlineData(typeof(DateTime))
    @InlineData(typeof(Guid))
    @InlineData(typeof(string))
    func MapClrTypeToReferences_Lets_Open_Generic_Construct_Under_MetadataLoadContext(elementType Type) {
        // Regression for issue #290. When references are loaded through a
        // MetadataLoadContext (the SDK build path), an open generic resolved
        // from those references rejects a host-runtime type argument:
        // MakeGenericType demands every argument come from the SAME context.
        let resolver = BuildMetadataLoadContextResolver()
        Assert.True(resolver.TryResolveType("System.Threading.Tasks.Task`1", out var openTask))
        // Sanity check: the bug. A host-runtime type argument is rejected.
        Assert.Throws[ArgumentException](
            func () object? {
                return openTask.MakeGenericType(elementType)
            }
        )
        // The fix: projecting the host type through the resolver yields a
        // context-compatible argument, so Task<T> constructs successfully.
        let projected = resolver.MapClrTypeToReferences(elementType)
        let closed = openTask.MakeGenericType(projected)
        Assert.Equal("System.Threading.Tasks.Task`1", closed.GetGenericTypeDefinition().FullName)
        Assert.Equal(elementType.FullName, closed.GetGenericArguments()[0].FullName)
    }

    @Fact
    func MapClrTypeToReferences_Projects_Nested_Generic_Arguments() {
        // Constructed generics and arrays must be projected element-by-element
        // so nested type arguments are also pulled into the load context.
        let resolver = BuildMetadataLoadContextResolver()
        Assert.True(resolver.TryResolveType("System.Threading.Tasks.Task`1", out var openTask))
        let projectedList = resolver.MapClrTypeToReferences(typeof(List[int32]))
        let closed = openTask.MakeGenericType(projectedList)
        Assert.Equal(typeof(List[int32]).FullName, closed.GetGenericArguments()[0].FullName)
        let projectedArray = resolver.MapClrTypeToReferences(typeof([]int32))
        Assert.True(projectedArray.IsArray)
        Assert.Equal(typeof([]int32).FullName, projectedArray.FullName)
    }

    @Fact
    func MapClrTypeToReferences_Projects_NonPublicNestedInfrastructureType() {
        let section Type? = typeof(PEBuilder).GetNestedType("Section", BindingFlags.Public | BindingFlags.NonPublic)
        Assert.NotNull(section)
        let paths = []string{typeof(object).Assembly.Location, typeof(PEBuilder).Assembly.Location}.Where(
            (path string) -> !string.IsNullOrEmpty(path)
        )
            .Distinct(StringComparer.OrdinalIgnoreCase)
        let resolver = ReferenceResolver.WithReferences(paths)
        Assert.False(resolver.TryResolveType(section!!.FullName!!, out _))
        let projected Type? = resolver.MapClrTypeToReferences(section)
        Assert.NotSame(section, projected)
        Assert.Equal(section!!.FullName, projected!!.FullName)
    }

    @Fact
    func MapClrTypeToReferences_Projects_ByRef_Types() {
        let resolver = BuildMetadataLoadContextResolver()
        let projected = resolver.MapClrTypeToReferences(typeof(int32).MakeByRefType())
        Assert.True(projected.IsByRef)
        let element Type? = projected.GetElementType()
        Assert.Equal(typeof(int32).FullName, element!!.FullName)
        // The projected element must share the load context, so an open generic
        // resolved from the references accepts it.
        Assert.True(resolver.TryResolveType("System.Threading.Tasks.Task`1", out var openTask))
        let closed = openTask.MakeGenericType(element!!)
        Assert.Equal(typeof(int32).FullName, closed.GetGenericArguments()[0].FullName)
    }

    @Fact
    func MapClrTypeToReferences_Projects_Pointer_Types() {
        let resolver = BuildMetadataLoadContextResolver()
        let projected = resolver.MapClrTypeToReferences(typeof(int32).MakePointerType())
        Assert.True(projected.IsPointer)
        Assert.Equal(typeof(int32).FullName, projected.GetElementType()!!.FullName)
    }

    @Fact
    func MapClrTypeToReferences_Projects_Array_Of_ByRef_Element_Chain() {
        // Byref-to-array: the inner array element must also be projected.
        let resolver = BuildMetadataLoadContextResolver()
        let projected = resolver.MapClrTypeToReferences(typeof([]int32).MakeByRefType())
        Assert.True(projected.IsByRef)
        let arrayElement Type? = projected.GetElementType()
        Assert.True(arrayElement!!.IsArray)
        Assert.Equal(typeof([]int32).FullName, arrayElement!!.FullName)
    }

    @Fact
    func MapClrTypeToReferences_Passes_Through_Generic_Parameters() {
        let resolver = BuildMetadataLoadContextResolver()
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var openList))
        let genericParameter = openList.GetGenericArguments()[0]
        Assert.True(genericParameter.IsGenericParameter)
        // A generic parameter is meaningful only relative to its already-mapped
        // declaring definition; projection passes it through unchanged.
        let projected = resolver.MapClrTypeToReferences(genericParameter)
        Assert.Same(genericParameter, projected)
    }

    @Fact
    func MapClrTypeToReferences_Throws_Instead_Of_Silent_Host_Fallback() {
        // A type that cannot be resolved by name from the supplied references
        // (it is defined only in the host's test assembly) must surface as an
        // explicit error rather than silently returning the wrong-context host
        // type, which would fail opaquely later inside MakeGenericType.
        let resolver = BuildMetadataLoadContextResolver()
        let ex = Assert.Throws[InvalidOperationException](
            func () object? {
                return resolver.MapClrTypeToReferences(typeof(ReferenceResolverTests))
            }
        )
        Assert.Contains(typeof(ReferenceResolverTests).ToString(), ex.Message)
    }

    @Fact
    func TryResolveType_CachesHitsAndMissesForLifetimeOfResolver() {
        // Hot-path optimization: language-server binding issues thousands of
        // TryResolveType calls for the same name. Each uncached call iterates
        // every assembly in the reference set (~216 entries on a typical .NET
        // project) and is observably slow (~0.1ms per miss). The resolver
        // memoizes hits AND misses so the second lookup is O(1).
        let resolver = BuildMetadataLoadContextResolver()
        Assert.True(resolver.TryResolveType("System.String", out var first))
        Assert.True(resolver.TryResolveType("System.String", out var second))
        Assert.Same(first, second)
        Assert.False(resolver.TryResolveType("Foo.Bar.NotARealType", out var missFirst))
        Assert.False(resolver.TryResolveType("Foo.Bar.NotARealType", out var missSecond))
        Assert.Null(missFirst)
        Assert.Null(missSecond)
    }

    @Fact
    func TryResolveType_ResolvesTypesAcrossEverySuppliedAssembly() {
        // Issue #854: TryResolveType is backed by a full-name index built once
        // over the entire reference set. This guards the property the previous
        // per-assembly scan guaranteed — that a name defined in *any* supplied
        // assembly resolves, not just the first — so the index must span every
        // assembly. System.String lives in the core library, System.Console in
        // System.Console.dll, and Task`1 in System.Private.CoreLib/Threading,
        // covering distinct assemblies in the supplied set.
        let resolver = BuildMetadataLoadContextResolver()
        Assert.True(resolver.TryResolveType("System.String", out var stringType))
        Assert.True(resolver.TryResolveType("System.Console", out var consoleType))
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var listType))
        Assert.NotNull(stringType)
        Assert.NotNull(consoleType)
        Assert.NotNull(listType)
        // Types must originate from the resolver's isolated MetadataLoadContext,
        // not the gsc host runtime (a regression here would reintroduce the
        // cross-context identity mismatches the resolver exists to prevent).
        Assert.NotSame(typeof(string), stringType)
        Assert.NotSame(typeof(Console), consoleType)
    }

    shared {
        private func EmitCollisionAssembly(directory string, assemblyName string, accessibility string) string {
            let path = Path.Combine(directory, assemblyName + ".dll")
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{
                    CSharpSyntaxTree.ParseText(
                        "namespace ResolverCollision3445; $accessibility sealed class MarkerAttribute { }"
                    )
                },
                []PortableExecutableReference{MetadataReference.CreateFromFile(typeof(object).Assembly.Location)},
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }

        private func CreateNativePeImage()[]uint8 {
            let image = [512]uint8
            image[0] = uint8('M')
            image[1] = uint8('Z')
            BinaryPrimitives.WriteInt32LittleEndian(image.AsSpan(0x3c), 0x80)
            image[0x80] = uint8('P')
            image[0x81] = uint8('E')
            BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(0x84), 0x14c)
            BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(0x94), 0xe0)
            BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(0x96), 0x102)
            BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(0x98), 0x10b)
            BinaryPrimitives.WriteUInt32LittleEndian(image.AsSpan(0xb4), 0x400000)
            BinaryPrimitives.WriteUInt32LittleEndian(image.AsSpan(0xb8), 0x1000)
            BinaryPrimitives.WriteUInt32LittleEndian(image.AsSpan(0xbc), 0x200)
            BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(0xc0), 4)
            BinaryPrimitives.WriteUInt32LittleEndian(image.AsSpan(0xd0), 0x1000)
            BinaryPrimitives.WriteUInt32LittleEndian(image.AsSpan(0xd4), 0x200)
            BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(0xdc), 3)
            BinaryPrimitives.WriteUInt32LittleEndian(image.AsSpan(0xf4), 16)
            return image
        }

        private func BuildMetadataLoadContextResolver() ReferenceResolver {
            // Supplying explicit assembly paths forces ReferenceResolver to load
            // them into an isolated MetadataLoadContext, mirroring the SDK build.
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Threading.Tasks.Task[_]).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(Console).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }
    }
}
