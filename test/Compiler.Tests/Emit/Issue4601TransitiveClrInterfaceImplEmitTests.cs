// <copyright file="Issue4601TransitiveClrInterfaceImplEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4601: a G# type that lists an imported CLR interface must also list
/// that interface's base interfaces in its <c>InterfaceImpl</c> table, as csc
/// does.
/// </summary>
/// <remarks>
/// <para><b>The miscompile.</b> The CLR re-maps only the interfaces a type
/// itself lists. gsc emitted a row for the declared interface alone, so for
/// <c>class Derived : Base, IDerivedI</c>, where the imported <c>Base</c>
/// already implements <c>IBaseI</c> (the base of <c>IDerivedI</c>), the
/// <c>IBaseI</c> slots kept <c>Base</c>'s mapping. A member <c>Derived</c>
/// declared for an <c>IBaseI</c> slot was silently ignored by interface
/// dispatch: the program compiled without a diagnostic and ran the base
/// class's member. The same C# program dispatches to the derived member.</para>
/// <para><b>The fix.</b> <c>ReflectionMetadataEmitter.EmitInterfaceImplRows</c>
/// follows each declared CLR interface with its transitive base interfaces,
/// de-duplicated together with the #985 bridge rows. G#-declared interfaces
/// were already closed at bind time (#1006).</para>
/// <para><b>Discrimination witness (ADR-0154).</b> Reverting
/// <c>src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs</c> to its
/// parent state fails every <c>ReListedInterface_DispatchesToTheDerivedMember</c>
/// row (the base class's value is printed) and every
/// <c>EmittedInterfaceRows_AreTheTransitiveClosure</c> row (base rows missing),
/// and leaves every <c>AGreenNeighbour_KeepsItsDispatch</c> row passing.</para>
/// </remarks>
public class Issue4601TransitiveClrInterfaceImplEmitTests
{
    private const int RunTimeout = 60_000;

    private const string LibrarySource = """
        namespace Clib;

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

        public static class Probe
        {
            public static int Read(IBaseI x) => x.Value;
            public static int M(IM x) => x.M();
            public static int A(IA x) => x.A();
            public static string G(IG<string> x) => x.Get() ?? "null";
        }
        """;

    /// <summary>
    /// Shapes whose dispatch was wrong before the fix: a member declared for a
    /// base-interface slot that the imported base class already implements.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> MisdispatchedCases()
    {
        // The issue's repro: an implicit property for `IBaseI.Value`.
        yield return new object[]
        {
            "implicit-property-over-imported-base",
            """
            package P
            import System
            import Clib

            class Derived : Base, IDerivedI {
                prop Value int32 { get { return 2 } }
            }

            Console.WriteLine(Probe.Read(Derived()))
            Console.WriteLine(Derived().Value)
            """,
            new[] { "2", "2" },
        };

        // A diamond: `ID : IB, IC`, both over `IA`.
        yield return new object[]
        {
            "diamond-base-interfaces",
            """
            package P
            import System
            import Clib

            class DD : BaseD, ID {
                func A() int32 { return 4 }
            }

            Console.WriteLine(Probe.A(DD()))
            """,
            new[] { "4" },
        };

        // A generic interface closed over a CLR type.
        yield return new object[]
        {
            "generic-interface-over-imported-generic-base",
            """
            package P
            import System
            import Clib

            class GG : BaseG[string], IG2[string] {
                func Get() string { return "gg" }
            }

            Console.WriteLine(Probe.G(GG()))
            """,
            new[] { "gg" },
        };

        // The BCL shape from the issue: `IList[int32]` re-listed over
        // `Collection[int32]`, member for the `ICollection[int32]` slot.
        yield return new object[]
        {
            "bcl-ilist-over-collection",
            """
            package P
            import System
            import System.Collections.Generic
            import System.Collections.ObjectModel

            class Coll : Collection[int32], IList[int32] {
                prop IsReadOnly bool { get { return true } }
            }

            Console.WriteLine((Coll() as ICollection[int32])!!.IsReadOnly)
            """,
            new[] { "True" },
        };
    }

    /// <summary>
    /// Neighbours whose dispatch was already right and must stay so.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> GreenNeighbours()
    {
        // The negative control: re-listing `IDerivedI` without declaring a
        // member keeps the imported base's EXPLICIT implementation. The added
        // `IBaseI` row must not steal that mapping.
        yield return new object[]
        {
            "no-member-keeps-the-base-explicit-implementation",
            """
            package P
            import System
            import Clib

            class NoMember : ExplicitBase, IDerivedI {
            }

            Console.WriteLine(Probe.Read(NoMember()))
            """,
            new[] { "10" },
        };

        // An explicit implementation of a base-interface slot. The #985
        // bridge already emitted the explicit target's row before the fix.
        yield return new object[]
        {
            "explicit-implementation-of-a-base-interface-slot",
            """
            package P
            import System
            import Clib

            class DX : BaseM, IM2 {
                func (IM) M() int32 { return 3 }
            }

            Console.WriteLine(Probe.M(DX()))
            """,
            new[] { "3" },
        };

        // Two closed instantiations of one generic interface: neither row may
        // be lost to de-duplication.
        yield return new object[]
        {
            "two-instantiations-of-one-interface",
            """
            package P
            import System

            class Two : IComparable[int32], IComparable[string] {
                func CompareTo(other int32) int32 { return 1 }
                func CompareTo(other string) int32 { return 2 }
            }

            Console.WriteLine((Two() as IComparable[int32])!!.CompareTo(0))
            Console.WriteLine((Two() as IComparable[string])!!.CompareTo("x"))
            """,
            new[] { "1", "2" },
        };
    }

    /// <summary>
    /// Exact <c>InterfaceImpl</c> row sets, read from metadata (reflection's
    /// <c>GetInterfaces</c> computes the closure itself and cannot tell).
    /// </summary>
    /// <returns>Case name, G# source, type name, expected rows.</returns>
    public static IEnumerable<object[]> RowCases()
    {
        yield return new object[]
        {
            "concrete-bcl-interface",
            """
            package P
            import System
            import System.Collections.Generic
            import System.Collections.ObjectModel

            class Coll : Collection[int32], IList[int32] {
                prop IsReadOnly bool { get { return true } }
            }
            """,
            "Coll",
            new[] { "IList`1<Int32>", "ICollection`1<Int32>", "IEnumerable`1<Int32>", "IEnumerable" },
        };

        // A symbolic argument (a same-compilation class), with the #985
        // non-generic bridge: the bridge's `IEnumerable` and the closure's
        // must collapse to one row.
        yield return new object[]
        {
            "symbolic-argument-with-bridge",
            """
            package P
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
            }
            """,
            "RC",
            new[] { "IReadOnlyCollection`1<Shape>", "IEnumerable`1<Shape>", "IEnumerable" },
        };

        // A class type parameter as the argument.
        yield return new object[]
        {
            "type-parameter-argument",
            """
            package P
            import System
            import Clib

            class Box[T] : IG2[T] {
                func Get() T { return default(T) }
            }
            """,
            "Box`1",
            new[] { "IG2`1<!0>", "IG`1<!0>" },
        };

        // A diamond lists the shared base once.
        yield return new object[]
        {
            "diamond",
            """
            package P
            import System
            import Clib

            class DD : BaseD, ID {
                func A() int32 { return 4 }
            }
            """,
            "DD",
            new[] { "ID", "IB", "IA", "IC" },
        };
    }

    /// <summary>
    /// A member for a base-interface slot now wins interface dispatch.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines.</param>
    [Theory]
    [MemberData(nameof(MisdispatchedCases))]
    public void ReListedInterface_DispatchesToTheDerivedMember(string name, string source, string[] expectedLines)
        => CompileVerifyAndRun(name, source, expectedLines);

    /// <summary>
    /// Shapes that already dispatched correctly keep doing so.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines.</param>
    [Theory]
    [MemberData(nameof(GreenNeighbours))]
    public void AGreenNeighbour_KeepsItsDispatch(string name, string source, string[] expectedLines)
        => CompileVerifyAndRun(name, source, expectedLines);

    /// <summary>
    /// The emitted rows are exactly the transitive closure, without duplicates.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="typeName">The metadata name of the type to inspect.</param>
    /// <param name="expectedRows">The expected interface rows, in any order.</param>
    [Theory]
    [MemberData(nameof(RowCases))]
    public void EmittedInterfaceRows_AreTheTransitiveClosure(string name, string source, string typeName, string[] expectedRows)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4601_rows_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var log = Compile(tempDir, "Lib.gs", source, appPath, "/target:library", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{log}");

            var rows = ReadInterfaceRows(appPath, typeName);
            Assert.Equal(expectedRows.Length, rows.Count);
            Assert.Equal(expectedRows.OrderBy(r => r, StringComparer.Ordinal), rows.OrderBy(r => r, StringComparer.Ordinal));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static List<string> ReadInterfaceRows(string assemblyPath, string typeName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var provider = new RowNameProvider();
        foreach (var handle in reader.TypeDefinitions)
        {
            var type = reader.GetTypeDefinition(handle);
            if (reader.GetString(type.Name) != typeName)
            {
                continue;
            }

            var rows = new List<string>();
            foreach (var implHandle in type.GetInterfaceImplementations())
            {
                var iface = reader.GetInterfaceImplementation(implHandle).Interface;
                rows.Add(iface.Kind switch
                {
                    HandleKind.TypeDefinition => reader.GetString(reader.GetTypeDefinition((TypeDefinitionHandle)iface).Name),
                    HandleKind.TypeReference => reader.GetString(reader.GetTypeReference((TypeReferenceHandle)iface).Name),
                    HandleKind.TypeSpecification => reader.GetTypeSpecification((TypeSpecificationHandle)iface).DecodeSignature(provider, null),
                    _ => iface.Kind.ToString(),
                });
            }

            return rows;
        }

        throw new InvalidOperationException($"type '{typeName}' not found in {assemblyPath}");
    }

    private static void CompileVerifyAndRun(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4601_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.DoesNotContain(" error ", log, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{log}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();
        var compilation = CSharpCompilation.Create(
            "Clib",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        var libPath = Path.Combine(tempDir, "Clib.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "the C# library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return libPath;
    }

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(tpa)
            ? Enumerable.Empty<string>()
            : tpa.Split(Path.PathSeparator).Where(File.Exists);
    }

    /// <summary>Renders a TypeSpec as <c>Name`N&lt;Arg,...&gt;</c>.</summary>
    private sealed class RowNameProvider : ISignatureTypeProvider<string, object>
    {
        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[,]";

        public string GetByReferenceType(string elementType) => elementType + "&";

        public string GetFunctionPointerType(MethodSignature<string> signature) => "fnptr";

        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments)
            => genericType + "<" + string.Join(",", typeArguments) + ">";

        public string GetGenericMethodParameter(object genericContext, int index) => "!!" + index;

        public string GetGenericTypeParameter(object genericContext, int index) => "!" + index;

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;

        public string GetPinnedType(string elementType) => elementType;

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
            => reader.GetString(reader.GetTypeDefinition(handle).Name);

        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
            => reader.GetString(reader.GetTypeReference(handle).Name);

        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind)
            => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
    }
}
