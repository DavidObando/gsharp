// <copyright file="Issue4098StructuralAttributeTypeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4098: a G# STRUCTURAL type (<c>map</c>, tuple, <c>func</c>,
/// <c>chan</c>, <c>sequence</c>) over a same-compilation component serialised
/// its G# SPELLING into a custom-attribute blob.
/// </summary>
/// <remarks>
/// <para><b>Root cause.</b> Each structural symbol computes its <c>ClrType</c>
/// by closing an open BCL definition over its components. A same-compilation
/// component has no <c>ClrType</c> while binding, so the structural symbol's own
/// <c>ClrType</c> comes out null and
/// <c>CustomAttributeEncoder.GetSerializedTypeParts</c> fell through to
/// <c>GetMetadataTypeName</c>'s <c>default:</c> arm — bare <c>type.Name</c>,
/// which for these kinds is the G# display spelling
/// (<c>map[string,Status]</c>, <c>(Status) -&gt; bool</c>, <c>chan[Status]</c>),
/// qualified to the compilation's own assembly. Nothing can decode that.</para>
/// <para><b>Only reachable nested.</b> At top level <c>typeof(map[…])</c> is
/// rejected by GS0202, which gates on the operand's <c>ClrType</c>. An imported
/// generic closed over the erased surrogate HAS one, so <c>Box[map[…]]</c>
/// passes the gate and the component reaches emit unchecked.</para>
/// <para><b>The erasure surrogate is a second, quieter shape of the same
/// defect.</b> <c>map[string, List[Status]]</c> has a component
/// (<c>List[Status]</c>) whose <c>ClrType</c> is NON-null — it is
/// <c>List&lt;object&gt;</c>, closed over the erasure surrogate — so
/// <c>MapTypeSymbol.MakeClrType</c> succeeds and the old
/// <c>type.ClrType is { } clrType</c> fallback wrote a name that RESOLVES,
/// to the wrong type. A <c>{ ClrType: null }</c> guard on the structural arms
/// would leave that row broken, so the arms recurse symbolically and
/// unconditionally — exactly as the sibling <c>Slice</c>, <c>Array</c>,
/// <c>Rectangular</c> and <c>Nullable</c> arms already do.</para>
/// <para><b>Controls.</b> The same kinds over components that DO have a CLR
/// type (<c>map[string, int32]</c>, <c>(int32, string)</c>,
/// <c>func(int32) bool</c>) serialise correctly today and must keep doing so;
/// they are what identifies the trigger as a same-compilation component and
/// they prove the ungated recursion did not regress the working path.</para>
/// <para><b>Reified, not printed.</b> Every row is read back through a
/// <see cref="MetadataLoadContext"/> and described by walking the generic
/// definition and arguments, naming each part's declaring ASSEMBLY. A row whose
/// serialised name does not resolve reads as <c>!</c> plus the failure.</para>
/// <para><b>The broken rows failed in TWO ways, and the difference is the whole
/// argument for the ungated arms.</b> Nine of the ten threw — an undecodable G#
/// spelling (<c>map</c>, <c>chan</c>, <c>sequence</c>, <c>(Status) -&gt; bool</c>)
/// or an invalid assembly name. The tenth,
/// <c>MapOverImportedGenericOfSourceEnum</c>, did NOT throw: it resolved
/// perfectly well, to <c>Dictionary&lt;string, List&lt;int&gt;&gt;</c> — the
/// wrong type, read back without complaint. That row is the one a
/// <c>{ ClrType: null }</c> guard would have left broken, because its
/// <c>ClrType</c> is non-null; and it is the more dangerous of the two failures,
/// because nothing downstream can detect it. Saying "every broken row failed to
/// resolve" would erase exactly the distinction this fix turns on.</para>
/// <para><b>No new diagnostic.</b> These programs are legal and were accepted
/// before; only their metadata was wrong — the same as #4073.</para>
/// </remarks>
public class Issue4098StructuralAttributeTypeArgumentTests
{
    private const string LibrarySource = """
        using System;

        namespace HelperLib4098;

        [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
        public class MarkerAttribute : Attribute
        {
            public MarkerAttribute(Type value)
            {
                Value = value;
            }

            public Type Value { get; }
        }

        public class Box<T>
        {
        }
        """;

    private const string Preamble = """
        package P
        import System
        import System.Collections.Generic
        import HelperLib4098

        enum Status {
            Active,
            Retired
        }


        """;

    /// <summary>
    /// One row per structural kind over a same-compilation component, plus the
    /// controls over an all-CLR component.
    /// </summary>
    /// <returns>Row name, G# declaration, expected reified description.</returns>
    public static IEnumerable<object[]> Rows()
    {
        // --- The four kinds named in the issue, over a source enum. ---
        yield return new object[]
        {
            "MapOverSourceEnum",
            "typeof(Box[map[string, Status]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.Dictionary`2@System.Private.CoreLib[System.String@System.Private.CoreLib,P.Status@P]]",
        };
        yield return new object[]
        {
            "TupleOverSourceEnum",
            "typeof(Box[(int32, Status)])",
            "HelperLib4098.Box`1@HelperLib4098[System.ValueTuple`2@System.Private.CoreLib[System.Int32@System.Private.CoreLib,P.Status@P]]",
        };
        yield return new object[]
        {
            "FuncOverSourceEnum",
            "typeof(Box[func(Status) bool])",
            "HelperLib4098.Box`1@HelperLib4098[System.Func`2@System.Private.CoreLib[P.Status@P,System.Boolean@System.Private.CoreLib]]",
        };
        yield return new object[]
        {
            "ChanOverSourceEnum",
            "typeof(Box[chan[Status]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Threading.Channels.Channel`1@System.Threading.Channels[P.Status@P]]",
        };

        // --- The fifth kind, named in Issue4073's remarks but not in #4098. ---
        yield return new object[]
        {
            "SequenceOverSourceEnum",
            "typeof(Box[sequence[Status]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.IEnumerable`1@System.Private.CoreLib[P.Status@P]]",
        };

        // --- The erasure-surrogate shape: the component has a NON-null
        // ClrType, closed over the `object` surrogate, so the structural
        // symbol's own ClrType is non-null and resolves to the WRONG type.
        yield return new object[]
        {
            "MapOverImportedGenericOfSourceEnum",
            "typeof(Box[map[string, List[Status]]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.Dictionary`2@System.Private.CoreLib[System.String@System.Private.CoreLib,System.Collections.Generic.List`1@System.Private.CoreLib[P.Status@P]]]",
        };

        // --- Projection decisions that only bite at specific shapes. ---
        yield return new object[]
        {
            "VoidFuncOverSourceEnum",
            "typeof(Box[func(Status)])",
            "HelperLib4098.Box`1@HelperLib4098[System.Action`1@System.Private.CoreLib[P.Status@P]]",
        };
        yield return new object[]
        {
            "ReceiveOnlyChanOverSourceEnum",
            "typeof(Box[in chan[Status]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Threading.Channels.ChannelReader`1@System.Threading.Channels[P.Status@P]]",
        };
        yield return new object[]
        {
            "SendOnlyChanOverSourceEnum",
            "typeof(Box[out chan[Status]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Threading.Channels.ChannelWriter`1@System.Threading.Channels[P.Status@P]]",
        };
        yield return new object[]
        {
            "NestedStructuralOverSourceEnum",
            "typeof(Box[map[string, (int32, Status)]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.Dictionary`2@System.Private.CoreLib[System.String@System.Private.CoreLib,System.ValueTuple`2@System.Private.CoreLib[System.Int32@System.Private.CoreLib,P.Status@P]]]",
        };

        // --- Review feedback on PR #4140: two arms of the helper that no row
        // reached. Both SELECT something — an open definition, and a nesting
        // shape — so an untested arm is where a wrong projection hides.

        // The async-sequence arm picks a DIFFERENT open definition from the
        // sync one (`IAsyncEnumerable` rather than `IEnumerable`), and the two
        // share a symbol name, so nothing but the reified type tells them apart.
        yield return new object[]
        {
            "AsyncSequenceOverSourceEnum",
            "typeof(Box[async sequence[Status]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.IAsyncEnumerable`1@System.Private.CoreLib[P.Status@P]]",
        };

        // Above arity 7 a tuple nests its tail into `TRest`. A FLAT encoding
        // would read back plausibly at a glance, so the nesting is asserted
        // structurally: `ValueTuple`8` whose eighth argument is itself a
        // `ValueTuple`1` over the source enum.
        yield return new object[]
        {
            "LargeTupleOverSourceEnum",
            "typeof(Box[(int32, int32, int32, int32, int32, int32, int32, Status)])",
            "HelperLib4098.Box`1@HelperLib4098[System.ValueTuple`8@System.Private.CoreLib["
                + "System.Int32@System.Private.CoreLib,System.Int32@System.Private.CoreLib,"
                + "System.Int32@System.Private.CoreLib,System.Int32@System.Private.CoreLib,"
                + "System.Int32@System.Private.CoreLib,System.Int32@System.Private.CoreLib,"
                + "System.Int32@System.Private.CoreLib,"
                + "System.ValueTuple`1@System.Private.CoreLib[P.Status@P]]]",
        };

        // --- Controls: the same kinds over components that HAVE a CLR type.
        // These serialise correctly today and must keep doing so.
        yield return new object[]
        {
            "ControlMapOverImported",
            "typeof(Box[map[string, int32]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Collections.Generic.Dictionary`2@System.Private.CoreLib[System.String@System.Private.CoreLib,System.Int32@System.Private.CoreLib]]",
        };
        yield return new object[]
        {
            "ControlTupleOverImported",
            "typeof(Box[(int32, string)])",
            "HelperLib4098.Box`1@HelperLib4098[System.ValueTuple`2@System.Private.CoreLib[System.Int32@System.Private.CoreLib,System.String@System.Private.CoreLib]]",
        };
        yield return new object[]
        {
            "ControlFuncOverImported",
            "typeof(Box[func(int32) bool])",
            "HelperLib4098.Box`1@HelperLib4098[System.Func`2@System.Private.CoreLib[System.Int32@System.Private.CoreLib,System.Boolean@System.Private.CoreLib]]",
        };
        yield return new object[]
        {
            "ControlChanOverImported",
            "typeof(Box[chan[int32]])",
            "HelperLib4098.Box`1@HelperLib4098[System.Threading.Channels.Channel`1@System.Threading.Channels[System.Int32@System.Private.CoreLib]]",
        };
    }

    [Theory]
    [MemberData(nameof(Rows))]
    public void AStructuralAttributeTypeArgument_ReifiesToItsBclProjection(
        string name,
        string operand,
        string expected)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4098_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var source = Preamble
                + "@Marker(" + operand + ")\nclass " + name + " {\n}\n\nConsole.WriteLine(\"ok\")\n";
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.Empty(ErrorIds(appLog));
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            // Joined rather than compared as a collection: xUnit elides a long
            // element, and the whole point of a row is the FULL serialised
            // shape — an argument that reifies to a plausible-looking wrong
            // type differs from the expectation only deep inside the string.
            var actual = string.Join(" | ", ReifiedAttributeArguments(appPath, libPath, name));
            Assert.True(
                expected == actual,
                $"'{name}' reified wrongly.\nexpected: {expected}\nactual:   {actual}");
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

    private static string[] ReifiedAttributeArguments(string assemblyPath, string libPath, string typeName)
    {
        var paths = new List<string>(TrustedPlatformAssemblies())
        {
            assemblyPath,
            libPath,
        };

        using var context = new MetadataLoadContext(new PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)));
        var assembly = context.LoadFromAssemblyPath(assemblyPath);
        var target = assembly.GetTypes().Single(candidate => candidate.Name == typeName);

        var described = new List<string>();
        foreach (var attribute in target.GetCustomAttributesData())
        {
            if (attribute.AttributeType.Namespace?.StartsWith("HelperLib4098", StringComparison.Ordinal) != true)
            {
                continue;
            }

            IList<CustomAttributeTypedArgument> arguments;
            try
            {
                arguments = attribute.ConstructorArguments;
            }
            catch (Exception ex)
            {
                // A serialised name that does not resolve throws HERE rather
                // than reading back as something plausible. Record the failure
                // as the row's description so the red measurement is legible.
                described.Add("!" + ex.GetType().Name + ": " + ex.Message);
                continue;
            }

            foreach (var argument in arguments)
            {
                described.Add(argument.Value is Type type
                    ? Describe(type)
                    : "!not-a-type: " + (argument.Value?.ToString() ?? "nil"));
            }
        }

        return described.ToArray();
    }

    private static string Describe(Type type)
    {
        if (type.IsArray)
        {
            return Describe(type.GetElementType()!) + "[]";
        }

        if (type.IsConstructedGenericType)
        {
            var definition = type.GetGenericTypeDefinition();
            var arguments = type.GetGenericArguments().Select(Describe);
            return Describe(definition) + "[" + string.Join(",", arguments) + "]";
        }

        return (type.FullName ?? type.Name) + "@" + type.Assembly.GetName().Name;
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "HelperLib4098",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib4098.dll");
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
