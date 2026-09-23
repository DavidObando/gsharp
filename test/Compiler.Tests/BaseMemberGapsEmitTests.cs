// <copyright file="BaseMemberGapsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// ADR-0192 follow-on 2: base-member shapes that the real
/// <c>[GeneratedRegex]</c> output uses once cs2gs back-translates it to G#.
/// A feasibility spike that ran the generator and translated its
/// <c>RegexRunner</c> subclass found three general gsc gaps:
/// <list type="number">
///   <item>compound assignment and increment/decrement of a base-qualified
///   member (<c>base.runtextpos++</c>) reported GS0125;</item>
///   <item><c>base.M()</c> inside a function literal (a translated C# local
///   function) reported GS0383;</item>
///   <item>a <c>protected</c> static member of an imported base
///   (<c>Regex.ValidateMatchTimeout</c>) could not be called from the derived
///   class.</item>
/// </list>
/// <para>
/// Every case compiles with gsc, passes ILVerify, and runs: binding alone
/// cannot show that a base accessor was called non-virtually, or that a
/// base call hosted in a closure verifies.
/// </para>
/// </summary>
public class BaseMemberGapsEmitTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // Gap 1: every compound form on a protected field of an imported base.
        yield return new object[]
        {
            "compound-imported-base-field",
            @"
package P
import System
import System.Text.RegularExpressions

class Runner : RegexRunner {
    func Step() string {
        base.runtextpos = 5
        base.runtextpos++
        ++base.runtextpos
        base.runtextpos += 10
        base.runtextpos--
        let old = base.runtextpos++
        let now = ++base.runtextpos
        return ""$old $now ${base.runtextpos}""
    }
}

Console.WriteLine(Runner().Step())
",
            new[] { "16 18 18" },
        };

        // Gap 1: same-compilation base, overridden property. The base
        // accessors must be called non-virtually for both halves of the
        // compound, or the override's x100 read shows up.
        yield return new object[]
        {
            "compound-overridden-base-property",
            @"
package P
import System

open class Base {
    var store int32 = 1
    protected var f int32
    open prop P int32 {
        get -> store
        set { store = value }
    }
}

class Derived : Base {
    override prop P int32 {
        get -> base.P * 100
        set { }
    }

    func Go() string {
        base.P++
        base.P += 5
        let old = base.P--
        base.f += 3
        --base.f
        return ""$old ${base.P} $P ${base.f}""
    }
}

Console.WriteLine(Derived().Go())
",
            new[] { "7 6 600 2" },
        };

        // Gap 3: the generated Regex constructor validates its timeout through
        // the protected internal static Regex.ValidateMatchTimeout, qualified
        // and unqualified, and from a static member.
        yield return new object[]
        {
            "protected-static-imported-regex",
            @"
package P
import System
import System.Text.RegularExpressions

class Generated : Regex {
    init(timeout TimeSpan) {
        Regex.ValidateMatchTimeout(timeout)
        ValidateMatchTimeout(timeout)
    }

    shared {
        func Probe(timeout TimeSpan) string {
            try {
                ValidateMatchTimeout(timeout)
                return ""valid""
            } catch (e ArgumentOutOfRangeException) {
                return ""rejected""
            }
        }
    }
}

let g = Generated(Regex.InfiniteMatchTimeout)
Console.WriteLine(Generated.Probe(TimeSpan.FromSeconds(-1.0)))
Console.WriteLine(Generated.Probe(TimeSpan.FromSeconds(2.0)))
",
            new[] { "rejected", "valid" },
        };

        // Gap 3: same-compilation base. Unqualified inherited static methods,
        // and qualified protected static field and property compound writes.
        yield return new object[]
        {
            "protected-static-source-base",
            @"
package P
import System

open class Base {
    shared {
        protected func Guarded() int32 -> 7
        protected var count int32 = 3
        protected prop Scale int32 { get; set; }
    }
}

class Derived : Base {
    func Go() int32 {
        Base.count++
        Base.Scale = 2
        Base.Scale *= 5
        return Guarded() + Base.count + Base.Scale
    }

    shared {
        func GoStatic() int32 -> Guarded()
    }
}

Console.WriteLine(Derived().Go().ToString())
Console.WriteLine(Derived.GoStatic().ToString())
",
            new[] { "21", "7" },
        };

        // Gap 2: base calls, base auto-property accessors and a base method
        // group inside function literals, including a nested literal and an
        // async member. Every one targets a virtual member the derived class
        // overrides, so a non-virtual call left in the closure method would
        // fail ILVerify (ThisMismatch / LdftnNonFinalVirtual); the forwarder
        // keeps the call on the class's own `this`.
        yield return new object[]
        {
            "base-in-function-literal",
            @"
package P
import System
import System.Threading.Tasks

open class Base {
    open func Name() string { return ""base"" }
    open prop Auto int32 { get; set; }
}

class Derived : Base {
    override func Name() string { return ""derived"" }
    override prop Auto int32 {
        get -> 1000
        set { }
    }

    func Go() string {
        let call = func () string { return base.Name() }
        let prop = func (n int32) int32 {
            base.Auto = n
            let inner = () -> base.Auto + 1
            return inner()
        }
        let group = func () string {
            let h () -> string = base.Name
            return h()
        }
        return ""${call()} ${prop(41)} ${group()} ${Name()}""
    }

    async func GoAsync() Task[string] {
        await Task.Yield()
        let f = () -> base.Name()
        return f()
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Derived().GoAsync().Result)
",
            new[] { "base 42 base derived", "base" },
        };

        // All three gaps in the shape the [GeneratedRegex] output takes after
        // cs2gs: a Regex subclass validating its timeout through the
        // protected static Regex.ValidateMatchTimeout, and a RegexRunner
        // subclass that increments base.runtextpos and calls base.Crawlpos()
        // from a translated local function.
        yield return new object[]
        {
            "regex-generated-shape",
            @"
package P
import System
import System.Text.RegularExpressions

class GeneratedRegex : Regex {
    init(timeout TimeSpan) {
        ValidateMatchTimeout(timeout)
        Regex.ValidateMatchTimeout(timeout)
    }
}

class GeneratedRunner : RegexRunner {
    func Scan(start int32) string {
        base.runtextpos = start
        base.runcrawl = []int32{0, 0, 0, 0, 0}
        base.runcrawlpos = 2
        let uncapture = func () int32 {
            base.runtextpos++
            return base.Crawlpos()
        }
        let crawled = uncapture()
        ++base.runtextpos
        base.runtextpos += crawled
        return ""${base.runtextpos} $crawled""
    }
}

let r = GeneratedRegex(Regex.InfiniteMatchTimeout)
Console.WriteLine(GeneratedRunner().Scan(10))
",
            new[] { "15 3" },
        };
    }

    /// <summary>
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void BaseMemberShape_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_basegaps_").FullName;
        try
        {
            var (exit, stdout, stderr) = Compile(tempDir, name, source);
            Assert.True(exit == 0, $"gsc failed for '{name}':\nstdout:\n{stdout}\nstderr:\n{stderr}");
            var outPath = Path.Combine(tempDir, name + ".dll");
            IlVerifier.Verify(outPath);

            var (runExit, output) = RunDotnet(outPath);
            Assert.True(runExit == 0, $"'{name}' must run to completion. Exit {runExit}:\n{output}");

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
    /// Gap 3 against an imported base that declares <c>protected</c> static
    /// fields, properties and methods. The BCL has no public base class with
    /// a protected static field or property, so a C# library supplies one. A
    /// protected static member is reached qualified by the base's name and,
    /// for methods, unqualified; an unrelated class is still refused.
    /// </summary>
    [Fact]
    public void ImportedProtectedStaticFieldPropertyAndMethod_CompileVerifyAndRun()
    {
        const string csSource = """
            namespace BaseGaps.CSharp
            {
                public class Counter
                {
                    protected static int count = 1;
                    protected internal static int Scale { get; set; } = 2;
                    protected static string Tag(int value) => "t" + value;
                    public static int Peek() => count * 1000 + Scale;
                }
            }
            """;

        const string source = @"
package P
import System
import BaseGaps.CSharp

class Derived : Counter {
    func Go() string {
        Counter.count += 4
        Counter.count++
        Counter.Scale = Counter.Scale * 10
        Counter.Scale--
        return Tag(Counter.count) + "" "" + Counter.Tag(Counter.Scale)
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Counter.Peek().ToString())
";

        const string rejected = @"
package P
import BaseGaps.CSharp

class Unrelated {
    func Go() int32 -> Counter.count
}
";

        var tempDir = Directory.CreateTempSubdirectory("gs_basegaps_cs_").FullName;
        try
        {
            var library = BuildCsLibrary(tempDir, csSource, "BaseGaps.CSharp");

            var (exit, stdout, stderr) = Compile(tempDir, "imported-protected-static", source, library);
            Assert.True(exit == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            var outPath = Path.Combine(tempDir, "imported-protected-static.dll");
            IlVerifier.Verify(outPath, new[] { library });
            File.Copy(library, Path.Combine(tempDir, Path.GetFileName(library)), overwrite: true);

            var (runExit, output) = RunDotnet(outPath);
            Assert.True(runExit == 0, $"program must run to completion. Exit {runExit}:\n{output}");
            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(new[] { "t6 t19", "6019" }, lines);

            var (rejectedExit, rejectedStdout, rejectedStderr) = Compile(tempDir, "imported-protected-static-rejected", rejected, library);
            Assert.True(
                rejectedExit != 0,
                $"an unrelated class must not reach a protected static field.\nstdout:\n{rejectedStdout}\nstderr:\n{rejectedStderr}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string BuildCsLibrary(string workDir, string source, string assemblyName)
    {
        var csDir = Path.Combine(workDir, "csref");
        Directory.CreateDirectory(csDir);
        File.WriteAllText(Path.Combine(csDir, "Lib.cs"), source);
        File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Library</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
                <RunAnalyzers>false</RunAnalyzers>
                <NoWarn>1591</NoWarn>
                <AssemblyName>{assemblyName}</AssemblyName>
              </PropertyGroup>
            </Project>
            """);

        var outDir = Path.Combine(csDir, "out");
        var (exit, output) = RunProcess(csDir, "dotnet", "build", "-c", "Release", "--nologo", "-o", outDir);
        Assert.True(exit == 0, $"building the C# library failed:\n{output}");
        var dll = Path.Combine(outDir, assemblyName + ".dll");
        Assert.True(File.Exists(dll), $"C# library not found at {dll}");
        return dll;
    }

    private static (int Exit, string Output) RunProcess(string workingDir, string fileName, params string[] args)
    {
        var psi = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException($"could not start {fileName}");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, stdoutTask.Result + stderr);
    }

    private static (int Exit, string Stdout, string Stderr) Compile(string tempDir, string name, string source, params string[] extraReferences)
    {
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, source);
        var outPath = Path.Combine(tempDir, name + ".dll");

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        foreach (var reference in TrustedPlatformAssemblies().Concat(extraReferences))
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
            return (Program.Main(args.ToArray()), compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
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
