// <copyright file="Issue4614ClrStaticVirtualMethodImplEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4614: a G# type implementing an imported CLR interface's static
/// abstract / static virtual members gets <c>MethodImpl</c> rows binding each
/// slot to its static member, as csc emits them.
/// </summary>
/// <remarks>
/// <para><b>The defect.</b> The CLR never binds a static-virtual slot by name,
/// and gsc emitted <c>MethodImpl</c> rows for the static-virtual slots of
/// G#-declared interfaces only. For every imported interface the slots were
/// left unbound: a direct implementer (<c>struct SD : IS</c>) failed to load
/// (<c>TypeLoadException</c>), a defaulted static virtual silently kept the
/// interface's default, and a type re-listing such an interface over an
/// imported base that already implements it (<c>class DZ : BaseS, IS2</c>)
/// silently ran the base's member. The inherited shape the issue reports is
/// the one that failed silently; the gap covered every imported slot.</para>
/// <para><b>The fix.</b> <c>InterfaceImplEmitter.EmitClrStaticVirtualMethodImpls</c>
/// binds every static-virtual method, property-accessor and event-accessor slot of the
/// type's imported interface closure (the same <c>ClrInterfaceClosure</c> its
/// <c>InterfaceImpl</c> rows come from, #4601) to the type's own static
/// member of the same name and signature. A slot the type does not implement
/// gets no row, so an imported base's implementation or the slot's default
/// still applies.</para>
/// <para><b>Discrimination witness (ADR-0154).</b> Reverting
/// <c>src/Core/CodeAnalysis/Emit/InterfaceImplEmitter.cs</c> to its parent
/// state fails every <c>StaticVirtualSlot_BindsToTheStaticMember</c> row
/// (a <c>TypeLoadException</c>, or the base's / default's value) and leaves
/// every <c>AGreenNeighbour_KeepsItsBinding</c> row passing.</para>
/// </remarks>
public class Issue4614ClrStaticVirtualMethodImplEmitTests
{
    private const int RunTimeout = 60_000;

    private const string LibrarySource = """
        namespace Clib;

        public interface IS { static abstract int Z(); }
        public interface IS2 : IS { }
        public class BaseS : IS { public static int Z() => 1; }

        public interface ISV { static virtual int V() => 100; }
        public interface ISV2 : ISV { }

        public interface IP { static abstract int P { get; } }
        public interface IP2 : IP { }
        public interface IPV { static virtual int P { get => 1; set { } } }

        public interface IGen { static abstract int Count<U>(U u); }

        public interface IH<T> { static abstract int H(T x); }
        public interface IH2<T> : IH<T> { }

        public interface IEv { static abstract event System.Action Changed; }
        public interface IEv2 : IEv { }

        public interface IM2<T> { static abstract int M<U>(T x, U y); }
        public interface IInst<T> { int N<U>(T x, U y); }
        public interface IMA<T> { static abstract int M<U>(U[] us, T x); }
        public interface IArr<T> { int A(T[] xs); int B<U>(U[] us, T x); }

        public static class Probe
        {
            public static int Z<T>() where T : IS => T.Z();
            public static int V<T>() where T : ISV => T.V();
            public static int P<T>() where T : IP => T.P;
            public static int PV<T>() where T : IPV => T.P;
            public static int Count<T>() where T : IGen => T.Count<string>("abc");
            public static void Hook<T>(System.Action a) where T : IEv => T.Changed += a;
            public static int N<T, U>(IInst<T> i, T x, U y) => i.N(x, y);
            public static int A<T>(IArr<T> i, T[] xs) => i.A(xs);
            public static int B<T, U>(IArr<T> i, U[] us, T x) => i.B(us, x);
        }
        """;

    /// <summary>
    /// Shapes that failed to load or bound the wrong member before the fix.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> UnboundSlotCases()
    {
        yield return new object[]
        {
            "direct-struct",
            """
            package P
            import System
            import Clib

            struct SD : IS {
                shared {
                    func Z() int32 { return 7 }
                }
            }

            Console.WriteLine(Probe.Z[SD]())
            """,
            new[] { "7" },
        };

        yield return new object[]
        {
            "direct-class",
            """
            package P
            import System
            import Clib

            class CD : IS {
                shared {
                    func Z() int32 { return 8 }
                }
            }

            Console.WriteLine(Probe.Z[CD]())
            """,
            new[] { "8" },
        };

        // The issue's TypeLoadException shape: the slot is inherited through
        // the declared interface's base.
        yield return new object[]
        {
            "inherited-through-a-base-interface",
            """
            package P
            import System
            import Clib

            struct SZ : IS2 {
                shared {
                    func Z() int32 { return 7 }
                }
            }

            Console.WriteLine(Probe.Z[SZ]())
            """,
            new[] { "7" },
        };

        // The issue's silent shape: the imported base already implements the
        // slot, and the base's member ran instead of the derived one.
        yield return new object[]
        {
            "derived-over-an-imported-base",
            """
            package P
            import System
            import Clib

            class DZ : BaseS, IS2 {
                shared {
                    func Z() int32 { return 6 }
                }
            }

            Console.WriteLine(Probe.Z[DZ]())
            """,
            new[] { "6" },
        };

        // A defaulted static virtual the type overrides silently kept the
        // interface's default.
        yield return new object[]
        {
            "static-virtual-default-overridden",
            """
            package P
            import System
            import Clib

            struct VD : ISV {
                shared {
                    func V() int32 { return 5 }
                }
            }

            Console.WriteLine(Probe.V[VD]())
            """,
            new[] { "5" },
        };

        // A get-only property overrides just the getter of a defaulted get/set
        // static virtual property; csc binds the getter independently too.
        yield return new object[]
        {
            "get-only-override-of-a-defaulted-get-set-property",
            """
            package P
            import System
            import Clib

            struct PG : IPV {
                shared {
                    prop P int32 { get { return 5 } }
                }
            }

            Console.WriteLine(Probe.PV[PG]())
            """,
            new[] { "5" },
        };

        yield return new object[]
        {
            "generic-static-method-slot",
            """
            package P
            import System
            import Clib

            struct GC : IGen {
                shared {
                    func Count[U](u U) int32 { return 42 }
                }
            }

            Console.WriteLine(Probe.Count[GC]())
            """,
            new[] { "42" },
        };

        yield return new object[]
        {
            "static-abstract-property",
            """
            package P
            import System
            import Clib

            struct PP : IP {
                shared {
                    prop P int32 { get { return 9 } }
                }
            }
            struct PP2 : IP2 {
                shared {
                    prop P int32 { get { return 10 } }
                }
            }

            Console.WriteLine(Probe.P[PP]())
            Console.WriteLine(Probe.P[PP2]())
            """,
            new[] { "9", "10" },
        };

        // A slot generic at both the interface and the method level, over a G#
        // type: the method-owned `U` is matched against the candidate's own
        // type parameter, never against the interface's `Shape`. The instance
        // counterpart shares the matcher (it reported GS0187 before).
        yield return new object[]
        {
            "symbolic-interface-with-a-generic-method",
            """
            package P
            import System
            import System.Linq
            import Clib

            class Shape { }
            struct GM : IM2[Shape] {
                shared {
                    func M[U](x Shape, y U) int32 { return 77 }
                }
            }
            class GI : IInst[Shape] {
                func N[U](x Shape, y U) int32 { return 88 }
            }

            let iface = typeof(GM).GetInterfaces().Where((i Type) -> i.Name == "IM2`1").First()
            let target = typeof(GM).GetInterfaceMap(iface).TargetMethods[0].MakeGenericMethod(typeof(string))
            Console.WriteLine(target.Invoke(nil, []object?{Shape(), "s"}))
            Console.WriteLine(Probe.N[Shape, string](GI(), Shape(), "s"))
            """,
            new[] { "77", "88" },
        };

        // Array positions that mention a generic parameter, at the interface
        // level (`T[]`) and the method level (`U[]`), over a G# type: matched
        // element-wise (both reported GS0187 before for the instance shape).
        yield return new object[]
        {
            "symbolic-array-positions",
            """
            package P
            import System
            import System.Linq
            import Clib

            class Shape { }
            class AR : IArr[Shape] {
                func A(xs []Shape) int32 { return xs.Length }
                func B[U](us []U, x Shape) int32 { return us.Length * 10 }
            }
            struct MA : IMA[Shape] {
                shared {
                    func M[U](us []U, x Shape) int32 { return us.Length * 100 }
                }
            }

            Console.WriteLine(Probe.A[Shape](AR(), []Shape{Shape(), Shape()}))
            Console.WriteLine(Probe.B[Shape, string](AR(), []string{"a", "b", "c"}, Shape()))
            let iface = typeof(MA).GetInterfaces().Where((i Type) -> i.Name == "IMA`1").First()
            let target = typeof(MA).GetInterfaceMap(iface).TargetMethods[0].MakeGenericMethod(typeof(string))
            Console.WriteLine(target.Invoke(nil, []object?{[]string{"a"}, Shape()}))
            """,
            new[] { "2", "30", "100" },
        };

        // A static abstract event binds through its accessors: custom accessors
        // through a base interface, and a field-like event directly.
        yield return new object[]
        {
            "static-abstract-event",
            """
            package P
            import System
            import Clib

            struct EV : IEv2 {
                shared {
                    var hooked int32 = 0
                    event Changed Action? {
                        add { hooked = hooked + 1 }
                        remove { }
                    }
                }
            }
            struct EF : IEv {
                shared {
                    event Changed Action?
                }
            }

            Probe.Hook[EV](() -> {})
            Console.WriteLine(EV.hooked)
            Probe.Hook[EF](() -> {})
            Console.WriteLine("hooked")
            """,
            new[] { "1", "hooked" },
        };

        // A generic interface closed over a G# type: the slot's declaration is
        // a MemberRef on the symbolic `IH<Shape>` TypeSpec. Read through the
        // runtime's interface map, which only loads when the slot is bound.
        yield return new object[]
        {
            "symbolic-generic-interface",
            """
            package P
            import System
            import System.Linq
            import Clib

            class Shape {
                prop N int32 { get { return 4 } }
            }
            struct HS : IH[Shape] {
                shared {
                    func H(x Shape) int32 { return x.N * 10 }
                }
            }
            struct HS2 : IH2[Shape] {
                shared {
                    func H(x Shape) int32 { return 11 }
                }
            }

            func Invoke(t Type) object? {
                let iface = t.GetInterfaces().Where((i Type) -> i.Name == "IH`1").First()
                return t.GetInterfaceMap(iface).TargetMethods[0].Invoke(nil, []object?{Shape()})
            }

            Console.WriteLine(Invoke(typeof(HS)))
            Console.WriteLine(Invoke(typeof(HS2)))
            """,
            new[] { "40", "11" },
        };
    }

    /// <summary>
    /// An explicit-interface-clause member (<c>func (IMine) Z()</c>) keeps the
    /// plain name <c>Z</c> but implements only the interface its clause
    /// names; the name-based match must skip it, whatever the declaration
    /// order. The G#-declared-interface path had the same hole.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> ExplicitClauseCases()
    {
        yield return new object[]
        {
            "explicit-member-of-another-interface-is-not-the-imported-slot",
            """
            package P
            import System
            import Clib

            interface IMine {
                shared {
                    func Z() int32;
                }
            }
            struct EX : IS, IMine {
                shared {
                    func (IMine) Z() int32 { return 4 }
                    func Z() int32 { return 5 }
                }
            }

            Console.WriteLine(Probe.Z[EX]())
            """,
            new[] { "5" },
        };

        yield return new object[]
        {
            "explicit-property-of-another-interface-is-not-the-imported-slot",
            """
            package P
            import System
            import Clib

            interface IMineP {
                shared {
                    prop P int32 { get }
                }
            }
            struct EP : IP, IMineP {
                shared {
                    prop (IMineP) P int32 { get { return 4 } }
                    prop P int32 { get { return 5 } }
                }
            }

            Console.WriteLine(Probe.P[EP]())
            """,
            new[] { "5" },
        };

        // The same rule for two G#-declared interfaces, read through the
        // runtime's interface map.
        yield return new object[]
        {
            "explicit-member-of-another-gsharp-interface",
            """
            package P
            import System

            interface IA {
                shared {
                    func Z() int32;
                }
            }
            interface IB {
                shared {
                    func Z() int32;
                }
            }
            struct W : IA, IB {
                shared {
                    func (IB) Z() int32 { return 4 }
                    func Z() int32 { return 5 }
                }
            }

            Console.WriteLine(typeof(W).GetInterfaceMap(typeof(IA)).TargetMethods[0].Invoke(nil, []object?{}))
            Console.WriteLine(typeof(W).GetInterfaceMap(typeof(IB)).TargetMethods[0].Invoke(nil, []object?{}))
            """,
            new[] { "5", "4" },
        };
    }

    /// <summary>
    /// Shapes whose binding was already right and must stay so.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> GreenNeighbours()
    {
        // The negative control: no static member, so no row, and the imported
        // base's implementation still applies.
        yield return new object[]
        {
            "no-member-keeps-the-base-implementation",
            """
            package P
            import System
            import Clib

            class NoZ : BaseS, IS2 {
            }

            Console.WriteLine(Probe.Z[NoZ]())
            """,
            new[] { "1" },
        };

        // No member for a defaulted static virtual: the default still applies.
        yield return new object[]
        {
            "no-member-keeps-the-default",
            """
            package P
            import System
            import Clib

            struct VN : ISV2 {
            }

            Console.WriteLine(Probe.V[VN]())
            """,
            new[] { "100" },
        };
    }

    /// <summary>
    /// Each static-virtual slot binds to the type's own static member.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines.</param>
    [Theory]
    [MemberData(nameof(UnboundSlotCases))]
    public void StaticVirtualSlot_BindsToTheStaticMember(string name, string source, string[] expectedLines)
        => CompileVerifyAndRun(name, source, expectedLines);

    /// <summary>
    /// Explicit-clause members never satisfy another interface's slot by name.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines.</param>
    [Theory]
    [MemberData(nameof(ExplicitClauseCases))]
    public void ExplicitClauseMember_IsNotAnImplicitImplementation(string name, string source, string[] expectedLines)
        => CompileVerifyAndRun(name, source, expectedLines);

    /// <summary>
    /// A type that declares only an explicit-clause member for another
    /// interface does not implement this one: the binder reports the missing
    /// static-virtual implementation (GS0331), because it applies the same
    /// implicit-candidate rule the emitter does. Before, the explicit member
    /// was silently bound to this interface's slot.
    /// </summary>
    [Fact]
    public void ExplicitClauseMemberOnly_ReportsTheMissingImplementation()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4614_missing_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "missing.dll");
            var log = Compile(
                tempDir,
                "App.gs",
                """
                package P
                import System

                interface IA {
                    shared {
                        func Z() int32;
                    }
                }
                interface IB {
                    shared {
                        func Z() int32;
                    }
                }
                struct W : IA, IB {
                    shared {
                        func (IB) Z() int32 { return 4 }
                    }
                }

                Console.WriteLine("ran")
                """,
                appPath,
                "/target:exe");
            Assert.Contains("GS0331", log, StringComparison.Ordinal);
            Assert.Contains("'IA", log, StringComparison.Ordinal);
            Assert.DoesNotContain("'IB", log, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Shapes without a member keep their inherited or default binding.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines.</param>
    [Theory]
    [MemberData(nameof(GreenNeighbours))]
    public void AGreenNeighbour_KeepsItsBinding(string name, string source, string[] expectedLines)
        => CompileVerifyAndRun(name, source, expectedLines);

    private static void CompileVerifyAndRun(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4614_").FullName;
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
        => CompileCSharpLibrary(tempDir, "Clib", LibrarySource);

    private static string CompileCSharpLibrary(string tempDir, string assemblyName, string source)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        var libPath = Path.Combine(tempDir, assemblyName + ".dll");
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
}
