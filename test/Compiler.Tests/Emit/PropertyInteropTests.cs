// <copyright file="PropertyInteropTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0051 E2E interop tests: validates that GSharp-declared properties are
/// consumable from C# projects. Compiles GSharp source to a library, then
/// builds and runs a C# project that references the GSharp assembly and
/// exercises the property surface via standard C# syntax.
/// </summary>
public class PropertyInteropTests
{
    [Fact]
    public void CSharp_CanReadAndWrite_AutoProperty()
    {
        var gsSource = """
            package MyLib
            import System

            type Person class {
                prop Name string
                prop Age int32
            }
            """;

        var csSource = """
            using System;
            var p = new MyLib.Person();
            p.Name = "Alice";
            p.Age = 30;
            Console.WriteLine(p.Name);
            Console.WriteLine(p.Age);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("Alice\n30\n", output);
    }

    [Fact]
    public void CSharp_CanRead_ReadOnlyAutoProperty()
    {
        var gsSource = """
            package MyLib
            import System

            type Config class {
                prop Version int32 { get }
            }
            """;

        // Read-only property: C# can read but cannot write. We verify
        // that the getter works (returns default zero) and that the
        // property is recognized as get-only via reflection.
        var csSource = """
            using System;
            using System.Reflection;
            var c = new MyLib.Config();
            Console.WriteLine(c.Version);
            var prop = typeof(MyLib.Config).GetProperty("Version");
            Console.WriteLine(prop.CanRead);
            Console.WriteLine(prop.CanWrite);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("0\nTrue\nFalse\n", output);
    }

    [Fact]
    public void CSharp_CanRead_ComputedProperty()
    {
        var gsSource = """
            package MyLib
            import System

            type Rect class {
                prop Width int32
                prop Height int32
                prop Area int32 {
                    get {
                        return this.Width * this.Height
                    }
                }
            }
            """;

        var csSource = """
            using System;
            var r = new MyLib.Rect();
            r.Width = 5;
            r.Height = 7;
            Console.WriteLine(r.Area);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("35\n", output);
    }

    [Fact]
    public void CSharp_CanReadAndWrite_ComputedPropertyWithSetter()
    {
        var gsSource = """
            package MyLib
            import System

            type Clamped class {
                prop raw int32
                prop Value int32 {
                    get { return this.raw }
                    set(v) { this.raw = v }
                }
            }
            """;

        var csSource = """
            using System;
            var c = new MyLib.Clamped();
            c.Value = 42;
            Console.WriteLine(c.Value);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void CSharp_CanAccessVirtualProperty_ThroughBaseType()
    {
        var gsSource = """
            package MyLib
            import System

            type Animal open class {
                open prop Sound string
            }

            type Dog class : Animal {
                override prop Sound string
            }
            """;

        var csSource = """
            using System;
            MyLib.Animal a = new MyLib.Dog();
            a.Sound = "Woof";
            Console.WriteLine(a.Sound);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("Woof\n", output);
    }

    [Fact]
    public void CSharp_CanAccessVirtualProperty_OverrideChangesGetter()
    {
        var gsSource = """
            package MyLib
            import System

            type Base open class {
                open prop Label string {
                    get { return "base" }
                }
            }

            type Derived class : Base {
                override prop Label string {
                    get { return "derived" }
                }
            }
            """;

        var csSource = """
            using System;
            MyLib.Base b = new MyLib.Derived();
            Console.WriteLine(b.Label);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("derived\n", output);
    }

    [Fact]
    public void CSharp_CanImplementInterface_WithGSharpProperty()
    {
        var gsSource = """
            package MyLib
            import System

            type Named interface {
                prop Name string { get }
            }

            type User class : Named {
                prop Name string
            }
            """;

        var csSource = """
            using System;
            MyLib.Named n = new MyLib.User();
            // User has both get and set, but Named only requires get
            ((MyLib.User)n).Name = "Bob";
            Console.WriteLine(n.Name);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("Bob\n", output);
    }

    [Fact]
    public void CSharp_PropertyVisibleToReflection_HasCorrectMetadata()
    {
        var gsSource = """
            package MyLib
            import System

            type Widget class {
                prop Id int32
                prop Label string
                prop IsActive bool
            }
            """;

        var csSource = """
            using System;
            using System.Reflection;
            var t = typeof(MyLib.Widget);
            var props = t.GetProperties(BindingFlags.Public | BindingFlags.Instance);
            foreach (var p in props)
            {
                Console.WriteLine($"{p.Name}:{p.PropertyType.Name}:{p.CanRead}:{p.CanWrite}");
            }
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Contains("Id:Int32:True:True", output);
        Assert.Contains("Label:String:True:True", output);
        Assert.Contains("IsActive:Boolean:True:True", output);
    }

    [Fact]
    public void CSharp_PropertyAccessors_AreSpecialName()
    {
        var gsSource = """
            package MyLib
            import System

            type Item class {
                prop Name string
            }
            """;

        var csSource = """
            using System;
            using System.Reflection;
            var t = typeof(MyLib.Item);
            var getter = t.GetMethod("get_Name");
            var setter = t.GetMethod("set_Name");
            Console.WriteLine(getter.IsSpecialName);
            Console.WriteLine(setter.IsSpecialName);
            Console.WriteLine(getter.IsHideBySig);
            Console.WriteLine(setter.IsHideBySig);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("True\nTrue\nTrue\nTrue\n", output);
    }

    [Fact]
    public void CSharp_CanUseGSharpProperty_InObjectInitializer()
    {
        var gsSource = """
            package MyLib
            import System

            type Config class {
                prop Host string
                prop Port int32
            }
            """;

        var csSource = """
            using System;
            var cfg = new MyLib.Config { Host = "localhost", Port = 8080 };
            Console.WriteLine(cfg.Host);
            Console.WriteLine(cfg.Port);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("localhost\n8080\n", output);
    }

    [Fact]
    public void CSharp_CanSerialize_GSharpPropertiesWithSystemTextJson()
    {
        var gsSource = """
            package MyLib
            import System

            type Product class {
                prop Name string
                prop Price int32
            }
            """;

        var csSource = """
            using System;
            using System.Text.Json;
            var p = new MyLib.Product();
            p.Name = "Widget";
            p.Price = 999;
            var json = JsonSerializer.Serialize(p);
            Console.WriteLine(json);
            var p2 = JsonSerializer.Deserialize<MyLib.Product>(json);
            Console.WriteLine(p2.Name);
            Console.WriteLine(p2.Price);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Contains("\"Name\":\"Widget\"", output);
        Assert.Contains("\"Price\":999", output);
        Assert.Equal("Widget", output.Split('\n')[1]);
        Assert.Equal("999", output.Split('\n')[2]);
    }

    [Fact]
    public void CSharp_DataStruct_ComputedProperty_IsAccessible()
    {
        var gsSource = """
            package MyLib
            import System

            type Vec2 data struct {
                var X int32
                var Y int32
                prop LengthSquared int32 {
                    get { return this.X * this.X + this.Y * this.Y }
                }
            }
            """;

        var csSource = """
            using System;
            var v = new MyLib.Vec2();
            v.X = 3;
            v.Y = 4;
            Console.WriteLine(v.LengthSquared);
            """;

        var output = CompileGSharpAndRunCSharp(gsSource, csSource);
        Assert.Equal("25\n", output);
    }

    /// <summary>
    /// Compiles GSharp source to a library DLL, then creates a C# project
    /// referencing it, builds, and runs the C# project. Returns stdout.
    /// </summary>
    private static string CompileGSharpAndRunCSharp(string gsSource, string csSource)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_prop_interop_").FullName;
        try
        {
            // Step 1: Compile GSharp to a library DLL
            var gsDir = Path.Combine(tempDir, "gslib");
            Directory.CreateDirectory(gsDir);
            var gsSrcPath = Path.Combine(gsDir, "lib.gs");
            var gsDllPath = Path.Combine(gsDir, "MyLib.dll");
            File.WriteAllText(gsSrcPath, gsSource);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + gsDllPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    gsSrcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(gsDllPath);

            Assert.True(File.Exists(gsDllPath), $"GSharp DLL not found at {gsDllPath}");

            // Step 2: Create a C# console project referencing the GSharp DLL
            var csDir = Path.Combine(tempDir, "csapp");
            Directory.CreateDirectory(csDir);

            var csProjContent = $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Exe</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                  </PropertyGroup>
                  <ItemGroup>
                    <Reference Include="MyLib">
                      <HintPath>{gsDllPath}</HintPath>
                    </Reference>
                  </ItemGroup>
                </Project>
                """;
            File.WriteAllText(Path.Combine(csDir, "CsApp.csproj"), csProjContent);
            File.WriteAllText(Path.Combine(csDir, "Program.cs"), csSource);

            // Step 3: Build the C# project
            var buildPsi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = csDir,
            };
            buildPsi.ArgumentList.Add("build");
            buildPsi.ArgumentList.Add("--nologo");
            buildPsi.ArgumentList.Add("-c");
            buildPsi.ArgumentList.Add("Release");
            buildPsi.ArgumentList.Add("--no-restore");

            // First restore (needed for new project)
            var restorePsi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = csDir,
            };
            restorePsi.ArgumentList.Add("restore");

            using var restoreProc = Process.Start(restorePsi)!;
            restoreProc.StandardOutput.ReadToEnd();
            var restoreErr = restoreProc.StandardError.ReadToEnd();
            restoreProc.WaitForExit(60_000);
            Assert.True(
                restoreProc.ExitCode == 0,
                $"dotnet restore failed:\n{restoreErr}");

            using var buildProc = Process.Start(buildPsi)!;
            var buildStdout = buildProc.StandardOutput.ReadToEnd();
            var buildStderr = buildProc.StandardError.ReadToEnd();
            buildProc.WaitForExit(60_000);
            Assert.True(
                buildProc.ExitCode == 0,
                $"dotnet build failed:\nstdout:\n{buildStdout}\nstderr:\n{buildStderr}");

            // Step 4: Run the C# project
            var runPsi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = csDir,
            };
            runPsi.ArgumentList.Add("run");
            runPsi.ArgumentList.Add("-c");
            runPsi.ArgumentList.Add("Release");
            runPsi.ArgumentList.Add("--no-build");

            using var runProc = Process.Start(runPsi)!;
            var stdout = runProc.StandardOutput.ReadToEnd();
            var stderr = runProc.StandardError.ReadToEnd();
            runProc.WaitForExit(30_000);
            Assert.True(
                runProc.ExitCode == 0,
                $"dotnet run failed (exit {runProc.ExitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
