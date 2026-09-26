// <copyright file="Issue4481CovariantPropertyOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4481: a property override that narrows the base property's type
/// (a C# 9 covariant override, <c>override PropertySymbol Property { get; }</c>
/// over <c>abstract Symbol? Property { get; }</c>) compiled cleanly but the
/// type failed to load: "Method 'get_Property' ... does not have an
/// implementation".
/// </summary>
/// <remarks>
/// <para>The binder picked the base property by name and never compared the
/// types, so the override's getter reused the base slot "by name" with a
/// return type the CLR does not treat as the same signature — the base slot
/// was left unimplemented. The migrated <c>GSharp.Core</c> hit it on
/// <c>BoundPropertyAccessExpression.Property</c> (#4441). The getter now takes
/// a new slot bound to the base getter by a MethodImpl row, with
/// <c>PreserveBaseOverridesAttribute</c>, as Roslyn emits it; a type that is
/// not a covariant narrowing is rejected instead of silently accepted.</para>
/// <para>Each case compiles, IL-verifies, LOADS and runs, reading the property
/// through the base-typed reference: compiling alone passed before the fix.
/// Every covariant executable case failed with the TypeLoadException before it.</para>
/// </remarks>
public class Issue4481CovariantPropertyOverrideTests
{
    private const string Symbols = @"
open class Sym {
    init(name string) {
        Name = name
    }

    prop Name string { get; }
}

class PSym : Sym {
    init(name string) : base(name) {
    }

    prop Tag string -> ""p:"" + Name
}
";

    /// <summary>The executable cases: name, G# source, expected stdout lines.</summary>
    /// <returns>The cases.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The #4441 shape as written in G#: a get-only auto-property override
        // assigned in the constructor.
        yield return new object[]
        {
            "auto-property",
            @"
open class Node {
    open prop Property Sym? { get; }
}

class Access : Node {
    init(p PSym) {
        Property = p
    }

    override prop Property PSym { get; }
}

let n Node = Access(PSym(""x""))
Console.WriteLine(n.Property!!.Name)
let a = Access(PSym(""y""))
Console.WriteLine(a.Property.Tag)
",
            new[] { "x", "p:y" },
        };

        // The shape cs2gs translates the C# get-only override into: a private
        // backing field and an arrow getter.
        yield return new object[]
        {
            "arrow-getter",
            @"
open class Node {
    open prop Property Sym? { get; }
}

class Access : Node {
    init(p PSym) {
        _property = p
    }

    private var _property PSym
    override prop Property PSym -> _property
}

let n Node = Access(PSym(""x""))
Console.WriteLine(n.Property!!.Name)
",
            new[] { "x" },
        };

        // A further override of the covariant override reuses ITS slot, and a
        // call through the original base slot still reaches it.
        yield return new object[]
        {
            "chained-override",
            @"
open class Node {
    open prop Property Sym? { get; }
}

open class Access : Node {
    init(p PSym) {
        _property = p
    }

    private var _property PSym
    open override prop Property PSym -> _property
}

class Leaf : Access {
    init(p PSym) : base(p) {
    }

    override prop Property PSym -> PSym(""leaf"")
}

let n Node = Leaf(PSym(""x""))
Console.WriteLine(n.Property!!.Name)
let a Access = Leaf(PSym(""y""))
Console.WriteLine(a.Property.Tag)
",
            new[] { "leaf", "p:leaf" },
        };

        // The override's type is bound AFTER the overriding class (types are
        // ordered base-first, not by the types their members mention), so its
        // base class is unknown when the override is bound. The migrated
        // GSharp.Core has this order: Binding/ sorts before Symbols/.
        yield return new object[]
        {
            "override-type-declared-later",
            @"
class Access : Node {
    init(p Later) {
        _property = p
    }

    private var _property Later
    override prop Property Later -> _property
}

open class Node {
    open prop Property Sym? { get; }
}

class Later : Sym {
    init(name string) : base(name) {
    }
}

let n Node = Access(Later(""x""))
Console.WriteLine(n.Property!!.Name)
",
            new[] { "x" },
        };

        // A narrowing to a SOURCE interface: the check must run after interface
        // base clauses and class interface closures are bound, or `IDerived`
        // (and a class implementing `IBase` only through `IDerived`) does not
        // yet convert to `IBase`.
        yield return new object[]
        {
            "interface-and-transitive-narrowing",
            @"
open class Node {
    open prop Property IBase? { get; }
    open prop Other IBase? { get; }
}

class Access : Node {
    init(p Impl) {
        _property = p
        _other = p
    }

    private var _property IDerived
    private var _other Impl
    override prop Property IDerived -> _property
    override prop Other Impl -> _other
}

interface IBase { func Name() string; }
interface IDerived : IBase { }
class Impl : IDerived { func Name() string -> ""impl"" }

let n Node = Access(Impl())
Console.WriteLine(n.Property!!.Name())
Console.WriteLine(n.Other!!.Name())
",
            new[] { "impl", "impl" },
        };

        // Reference nullability is metadata only at every nesting level, so
        // `List[Sym]` over `List[Sym?]` (and the slice / dictionary shapes, which
        // the old top-level-only strip rejected) is the SAME slot type.
        // The setter makes that observable: a type change with a setter has no
        // covariant form, so treating it as one would report GS0185.
        yield return new object[]
        {
            "nested-nullability-same-slot",
            @"
open class Node {
    open prop Items List[Sym?] { get; set; }
    open prop Arr []Sym? { get; set; }
    open prop Map Dictionary[string, Sym?] { get; set; }
}

class Access : Node {
    init(items List[Sym]) {
        Items = items
    }

    override prop Items List[Sym] { get; set; }
    override prop Arr []Sym { get; set; }
    override prop Map Dictionary[string, Sym] { get; set; }
}

let items = List[Sym]()
items.Add(Sym(""x""))
let n Node = Access(items)
Console.WriteLine(n.Items[0]!!.Name)
",
            new[] { "x" },
        };

        // A same-type override (nullability aside) keeps reusing the base slot.
        yield return new object[]
        {
            "same-type-control",
            @"
open class Node {
    open prop Property Sym? { get; }
}

class Access : Node {
    init(p Sym) {
        Property = p
    }

    override prop Property Sym { get; }
}

let n Node = Access(Sym(""x""))
Console.WriteLine(n.Property!!.Name)
",
            new[] { "x" },
        };
    }

    /// <summary>
    /// Compiles each case, IL-verifies it, runs it, and asserts its output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# declarations and top-level statements.</param>
    /// <param name="expectedLines">The expected stdout lines.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void CovariantPropertyOverride_CompilesVerifiesLoadsAndRuns(string name, string body, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4481_").FullName;
        try
        {
            var (exitCode, diagnostics, outPath) = Compile(tempDir, name, body);
            Assert.True(exitCode == 0, $"gsc failed for '{name}':\n{diagnostics}");

            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
            Assert.True(exit == 0, $"'{name}' must load and run (a TypeLoadException is #4481). Exit {exit}:\n{output}");

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
    /// A type change that is not a covariant narrowing — a value type, an
    /// unrelated type, or a narrowed property that also has a setter — has no
    /// CLR override form, and used to be accepted silently.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="baseType">The base property's type.</param>
    /// <param name="overrideDeclaration">The override declaration.</param>
    [Theory]
    [InlineData("unrelated-value-type", "int32", "override prop Property string -> \"s\"")]
    [InlineData("widening", "PSym", "override prop Property Sym -> Sym(\"s\")")]
    [InlineData("narrowing-with-setter", "Sym", "override prop Property PSym { get; set; }")]
    public void NonCovariantPropertyTypeChange_IsRejected(string name, string baseType, string overrideDeclaration)
    {
        var body = $$"""
            open class Node {
                open prop Property {{baseType}} { get; set; }
            }

            class Access : Node {
                {{overrideDeclaration}}
            }
            """;
        var tempDir = Directory.CreateTempSubdirectory("gs_4481_").FullName;
        try
        {
            var (exitCode, diagnostics, _) = Compile(tempDir, name, body);
            Assert.True(exitCode != 0, $"'{name}' must be rejected.");
            Assert.Contains("GS0185", diagnostics, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A narrowing the CLR covariant-return form cannot express: a by-ref
    /// property (covariant returns are by-value only), or a base with no
    /// getter to bind the override's getter to (the emitter used to throw).
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="baseDeclaration">The base class member declarations.</param>
    /// <param name="overrideDeclaration">The override class member declarations.</param>
    [Theory]
    [InlineData(
        "by-ref-narrowing",
        "var slot Sym = Sym(\"a\")\nopen prop Property ref Sym { get { return ref slot } }",
        "var own PSym = PSym(\"b\")\noverride prop Property ref PSym { get { return ref own } }")]
    [InlineData(
        "getter-over-setter-only-base",
        "open prop Property Sym { set { } }",
        "override prop Property PSym -> PSym(\"s\")")]
    public void NarrowingWithNoCovariantForm_IsRejected(string name, string baseDeclaration, string overrideDeclaration)
    {
        var body = $$"""
            open class Node {
                {{baseDeclaration}}
            }

            class Access : Node {
                {{overrideDeclaration}}
            }
            """;
        var tempDir = Directory.CreateTempSubdirectory("gs_4481_").FullName;
        try
        {
            var (exitCode, diagnostics, _) = Compile(tempDir, name, body);
            Assert.True(exitCode != 0, $"'{name}' must be rejected.");
            Assert.Contains("GS0185", diagnostics, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static (int ExitCode, string Diagnostics, string OutPath) Compile(string tempDir, string name, string body)
    {
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, "package P\nimport System\nimport System.Collections.Generic\n" + Symbols + body);
        var outPath = Path.Combine(tempDir, name + ".dll");

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
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
        int exitCode;
        try
        {
            exitCode = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return (exitCode, compileOut + "\n" + compileErr, outPath);
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
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
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
