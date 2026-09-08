// <copyright file="Issue4056ConstructedGenericCompoundAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4056: a static COMPOUND assignment through a constructed generic
/// receiver whose type argument is a same-compilation type emitted a member
/// reference parented at the type-ERASED <c>Handler&lt;object&gt;</c> TypeSpec.
/// The program compiled with no diagnostic, ILVerify rejected the assembly with
/// <c>UnsatisfiedFieldParentInst</c>, and the CLR threw
/// <c>TypeLoadException: GenericArguments[0], 'System.Object', … violates the
/// constraint of type parameter 'TOptions'</c> — even though <c>MyOptions</c>
/// satisfies that constraint.
/// </summary>
/// <remarks>
/// <para><b>Root cause.</b> A same-compilation class has no <c>ClrType</c>
/// while binding (its TypeDef is only produced at emit), so
/// <c>TryCloseImportedGenericTypeReceiver</c> closes the imported generic over
/// the <c>System.Object</c> surrogate and records the real construction beside
/// it on <c>ImportedClassSymbol.SymbolicReceiver</c> (#1330/#2670). The READ
/// path (<c>ExpressionBinder.Access.MemberLookup.cs</c>) and the simple-WRITE
/// path (<c>BindMemberFieldAssignmentExpression</c>, which passes
/// <c>staticContainerType: constructedImported.SymbolicReceiver</c>) both carry
/// that symbol onto the bound node, so the emitter parents the member reference
/// at the real construction. The compound-assignment path
/// (<c>BindEventSubscriptionExpression</c> →
/// <c>TryBindStaticClrCompoundAssignment</c>) narrowed the receiver to
/// <c>ctorImported.ClassType</c> — the erased close — and passed
/// <c>staticContainerType: null</c>, so the surrogate reached emit.</para>
/// <para><b>Why the read and simple-write rows are here.</b> The issue reports
/// them as already correct; they are the control that the repair changed nothing
/// on the paths that were fine, and they are what proves the compound rows are
/// the only ones that ever named <c>object</c>.</para>
/// <para><b>Both halves of the compound needed the fix.</b> A compound
/// assignment is a read (<c>ldsfld</c> / <c>call get_X</c>) followed by a write
/// (<c>stsfld</c> / <c>call set_X</c>), and the binder builds two bound nodes.
/// Threading the symbolic container onto the assignment alone still left the
/// read half naming <c>Handler&lt;object&gt;</c>, so ILVerify stayed red; both
/// <c>leftRead</c> and the <c>BoundClrPropertyAssignmentExpression</c> carry
/// it.</para>
/// <para><b>No new diagnostic.</b> This is wrong EMISSION of a construction the
/// language already accepts, not a missing rule — the constraint is satisfied
/// and #4032's check (which reads the symbol's base chain, not the surrogate) is
/// right to pass it. Nothing here reports, and nothing here suppresses.</para>
/// <para><b>Not #4051.</b> That issue is a diagnostic CASCADE on a receiver whose
/// constraint is genuinely violated; every row here satisfies its constraint and
/// must run.</para>
/// </remarks>
public class Issue4056ConstructedGenericCompoundAssignmentTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library every row links against. <c>Handler&lt;TOptions&gt;</c>
    /// carries the constraint from the issue; <c>Registry&lt;T&gt;</c> is its
    /// UNCONSTRAINED twin, so the type-parameter receiver row can be written
    /// without also exercising constraint checking. Each exposes a static field,
    /// a static integer field (for a non-<c>+=</c> operator) and a static
    /// property, so one library serves every member kind the compound-assignment
    /// binder reaches.
    /// </summary>
    private const string LibrarySource = """
        namespace HelperLib4056;

        public class SchemeOptions
        {
            public string? Name { get; set; }
        }

        public class Handler<TOptions>
            where TOptions : SchemeOptions
        {
            public static string Field = "f";

            public static int Count = 1;

            public static string Prop { get; set; } = "p";
        }

        public class Registry<T>
        {
            public static string Tag = "r";

            public static int Hits = 2;

            public static string Note { get; set; } = "n";
        }
        """;

    /// <summary>
    /// Every receiver/member/operator spelling that reaches the constructed
    /// generic static-member paths. The rows whose type argument is a
    /// same-compilation type (or contains one) were the broken ones; the rows
    /// over an IMPORTED argument, and the read/simple-write spellings, are the
    /// controls that were already green and must stay byte-for-byte correct.
    /// </summary>
    /// <returns>Case name, G# source, and the expected stdout lines.</returns>
    public static IEnumerable<object[]> CompoundShapes()
    {
        // --- The issue's repro, and its member-kind/operator siblings. ---
        yield return new object[]
        {
            "compound-field-source-argument",
            """
            package P
            import System
            import HelperLib4056

            class MyOptions : SchemeOptions {
            }

            Handler[MyOptions].Field += "z"
            Console.WriteLine(Handler[MyOptions].Field)
            """,
            new[] { "fz" },
        };

        yield return new object[]
        {
            "compound-property-source-argument",
            """
            package P
            import System
            import HelperLib4056

            class MyOptions : SchemeOptions {
            }

            Handler[MyOptions].Prop += "z"
            Console.WriteLine(Handler[MyOptions].Prop)
            """,
            new[] { "pz" },
        };

        // Issue #2154: a non-`+=` compound operator never probes for an event,
        // so it enters the constructed-generic branch by a different route.
        yield return new object[]
        {
            "compound-field-multiply-source-argument",
            """
            package P
            import System
            import HelperLib4056

            class MyOptions : SchemeOptions {
            }

            Handler[MyOptions].Count *= 3
            Console.WriteLine(Handler[MyOptions].Count)
            """,
            new[] { "3" },
        };

        yield return new object[]
        {
            "compound-property-unconstrained-source-argument",
            """
            package P
            import System
            import HelperLib4056

            class Item {
            }

            Registry[Item].Note += "?"
            Console.WriteLine(Registry[Item].Note)
            """,
            new[] { "n?" },
        };

        // Issue #2670: the same-compilation type nested inside an imported
        // generic argument — `Registry[List[Item]]` — is retained by the same
        // gate and was erased the same way.
        yield return new object[]
        {
            "compound-field-nested-source-argument",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib4056

            class Item {
            }

            Registry[List[Item]].Hits += 5
            Console.WriteLine(Registry[List[Item]].Hits)
            """,
            new[] { "7" },
        };

        // Issue #1330: an in-scope type PARAMETER receiver is erased to the same
        // `object` surrogate for the same reason, and reaches the same branch.
        yield return new object[]
        {
            "compound-field-type-parameter-receiver",
            """
            package P
            import System
            import HelperLib4056

            func bump[T]() string {
                Registry[T].Tag += "!"
                return Registry[T].Tag
            }

            class Item {
            }

            Console.WriteLine(bump[Item]())
            """,
            new[] { "r!" },
        };

        // --- Controls. Already green before the fix; must stay green. ---
        yield return new object[]
        {
            "read-source-argument",
            """
            package P
            import System
            import HelperLib4056

            class MyOptions : SchemeOptions {
            }

            Console.WriteLine(Handler[MyOptions].Field)
            """,
            new[] { "f" },
        };

        yield return new object[]
        {
            "simple-write-source-argument",
            """
            package P
            import System
            import HelperLib4056

            class MyOptions : SchemeOptions {
            }

            Handler[MyOptions].Field = "z"
            Console.WriteLine(Handler[MyOptions].Field)
            """,
            new[] { "z" },
        };

        // An IMPORTED type argument has a real CLR type, so no symbolic receiver
        // is ever recorded and this row never took the repaired branch. It is the
        // proof that the fix is scoped to the erased shape.
        yield return new object[]
        {
            "compound-field-imported-argument",
            """
            package P
            import System
            import HelperLib4056

            Handler[SchemeOptions].Field += "z"
            Console.WriteLine(Handler[SchemeOptions].Field)
            """,
            new[] { "fz" },
        };

        yield return new object[]
        {
            "compound-property-imported-argument",
            """
            package P
            import System
            import HelperLib4056

            Registry[string].Note += "?"
            Console.WriteLine(Registry[string].Note)
            """,
            new[] { "n?" },
        };
    }

    /// <summary>
    /// Every spelling compiles clean, IL-VERIFIES, runs to completion, and
    /// prints what the source says. ILVerify is the acceptance test here, not
    /// the printed output: the defect emitted a program that ran (until it
    /// touched the type) and printed nothing wrong on the paths that did work,
    /// so a test that only asserted stdout would have passed while the assembly
    /// stayed invalid.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(CompoundShapes))]
    public void AConstructedGenericStaticCompoundAssignment_CompilesVerifiesAndRuns(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4056_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.Empty(ErrorIds(appLog));
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath, libPath);
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

    /// <summary>
    /// The exact surrogate the issue names never appears in the emitted
    /// metadata. Asserted on the raw assembly bytes rather than on behaviour so
    /// the row fails even in a hypothetical runtime that tolerated the bad
    /// instantiation: the string <c>Handler`1&lt;object&gt;</c> reaches metadata
    /// as a TypeSpec over <c>System.Object</c>, and the fixed emitter writes the
    /// TypeDef of <c>MyOptions</c> instead. Counted, not merely absent —
    /// <c>MyOptions</c> must be the argument of the ONE constructed
    /// <c>Handler</c> TypeSpec the program needs.
    /// </summary>
    [Fact]
    public void TheEmittedTypeSpecNamesTheSourceTypeArgumentAndNotTheObjectSurrogate()
    {
        const string Source = """
            package P
            import System
            import HelperLib4056

            class MyOptions : SchemeOptions {
            }

            Handler[MyOptions].Field += "z"
            Console.WriteLine(Handler[MyOptions].Field)
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4056_meta_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"the sample must compile. Log:\n{appLog}");

            // Three references reach metadata: the compound read (`ldsfld`),
            // the compound write (`stsfld`), and the trailing `Console.WriteLine`
            // read. All three must name the construction the author wrote.
            // Counted, not merely inspected: repairing the write alone left the
            // read half on `Handler<object>` and ILVerify stayed red, so a
            // presence-only assertion would have called that a fix.
            var specs = DescribeConstructedGenerics(appPath, "Handler");
            Assert.Equal(
                new[]
                {
                    "HelperLib4056.Handler`1<P.MyOptions>",
                    "HelperLib4056.Handler`1<P.MyOptions>",
                    "HelperLib4056.Handler`1<P.MyOptions>",
                },
                specs);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] ErrorIds(string log)
        => Regex.Matches(log, @"error (GS[0-9]{4})")
            .Select(match => match.Groups[1].Value)
            .ToArray();

    /// <summary>
    /// Reads every <c>TypeSpec</c> row in the emitted assembly and returns the
    /// decoded shapes whose generic definition name contains
    /// <paramref name="definitionNameFragment"/>, in table order. Reading the
    /// metadata directly (rather than reflecting) is what makes the assertion
    /// about the EMITTED instantiation instead of about a runtime that might
    /// resolve it leniently.
    /// </summary>
    /// <param name="assemblyPath">The emitted assembly.</param>
    /// <param name="definitionNameFragment">The generic definition name to select on.</param>
    /// <returns>The decoded constructed-generic shapes.</returns>
    private static string[] DescribeConstructedGenerics(string assemblyPath, string definitionNameFragment)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var provider = new QualifiedNameSignatureProvider();
        var shapes = new List<string>();
        for (var row = 1; row <= reader.GetTableRowCount(TableIndex.TypeSpec); row++)
        {
            var handle = MetadataTokens.TypeSpecificationHandle(row);
            var decoded = reader.GetTypeSpecification(handle).DecodeSignature(provider, genericContext: new object());
            if (decoded.Contains(definitionNameFragment, StringComparison.Ordinal))
            {
                shapes.Add(decoded);
            }
        }

        return shapes.ToArray();
    }

    /// <summary>
    /// Decodes a type signature to a namespace-qualified display form, so a
    /// constructed generic reads as <c>Ns.Def`1&lt;Ns.Arg&gt;</c> and the
    /// erased shape this issue emitted would read as
    /// <c>HelperLib4056.Handler`1&lt;Object&gt;</c>.
    /// </summary>
    private sealed class QualifiedNameSignatureProvider : ISignatureTypeProvider<string, object>
    {
        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetGenericTypeParameter(object genericContext, int index) => "!" + index;

        public string GetGenericMethodParameter(object genericContext, int index) => "!!" + index;

        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
        {
            var definition = reader.GetTypeDefinition(handle);
            return Qualify(reader.GetString(definition.Namespace), reader.GetString(definition.Name));
        }

        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
        {
            var reference = reader.GetTypeReference(handle);
            return Qualify(reader.GetString(reference.Namespace), reader.GetString(reference.Name));
        }

        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind)
            => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

        public string GetGenericInstantiation(string genericType, System.Collections.Immutable.ImmutableArray<string> typeArguments)
            => genericType + "<" + string.Join(",", typeArguments) + ">";

        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[]";

        public string GetByReferenceType(string elementType) => elementType + "&";

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetFunctionPointerType(MethodSignature<string> signature) => "method*";

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;

        public string GetPinnedType(string elementType) => elementType;

        public string GetTypeFromSerializedName(string name) => name;

        public PrimitiveTypeCode GetUnderlyingEnumType(string type) => PrimitiveTypeCode.Int32;

        public bool IsSystemType(string type) => false;

        private static string Qualify(string ns, string name)
            => string.IsNullOrEmpty(ns) ? name : ns + "." + name;
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "HelperLib4056",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib4056.dll");
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
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

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

    private static (int Exit, string Output) RunDotnet(string assemblyPath, string libPath)
    {
        var dir = Path.GetDirectoryName(assemblyPath) ?? ".";
        var sideBySide = Path.Combine(dir, Path.GetFileName(libPath));
        if (!File.Exists(sideBySide))
        {
            File.Copy(libPath, sideBySide);
        }

        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = dir,
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
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
