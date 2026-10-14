// <copyright file="PropertyInteropTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// ADR-0051 E2E interop tests: validates that GSharp-declared properties are
/// consumable from C# projects. Compiles GSharp source to a library, then
/// builds and runs a C# project that references the GSharp assembly and
/// exercises the property surface via standard C# syntax.
open class PropertyInteropTests {
    @Fact
    func CSharp_CanReadAndWrite_AutoProperty() {
        let gsSource = `package MyLib
import System

class Person {
    prop Name string
    prop Age int32
}`
        let csSource = `using System;
var p = new MyLib.Person();
p.Name = "Alice";
p.Age = 30;
Console.WriteLine(p.Name);
Console.WriteLine(p.Age);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal("Alice${Environment.NewLine}30${Environment.NewLine}", output)
    }

    @Fact
    func CSharp_CanRead_ReadOnlyAutoProperty() {
        let gsSource = `package MyLib
import System

class Config {
    prop Version int32 { get }
}`
        // Read-only property: C# can read but cannot write. We verify
        // that the getter works (returns default zero) and that the
        // property is recognized as get-only via reflection.
        let csSource = `using System;
using System.Reflection;
var c = new MyLib.Config();
Console.WriteLine(c.Version);
var prop = typeof(MyLib.Config).GetProperty("Version");
Console.WriteLine(prop.CanRead);
Console.WriteLine(prop.CanWrite);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal("0${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func CSharp_CanRead_ComputedProperty() {
        let gsSource = `package MyLib
import System

class Rect {
    prop Width int32
    prop Height int32
    prop Area int32 {
        get {
            return this.Width * this.Height
        }
    }
}`
        let csSource = `using System;
var r = new MyLib.Rect();
r.Width = 5;
r.Height = 7;
Console.WriteLine(r.Area);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal("35${Environment.NewLine}", output)
    }

    @Fact
    func CSharp_CanReadAndWrite_ComputedPropertyWithSetter() {
        let gsSource = `package MyLib
import System

class Clamped {
    prop raw int32
    prop Value int32 {
        get { return this.raw }
        set(v) { this.raw = v }
    }
}`
        let csSource = `using System;
var c = new MyLib.Clamped();
c.Value = 42;
Console.WriteLine(c.Value);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func CSharp_CanAccessVirtualProperty_ThroughBaseType() {
        let gsSource = `package MyLib
import System

open class Animal {
    open prop Sound string
}

class Dog : Animal {
    override prop Sound string
}`
        let csSource = `using System;
MyLib.Animal a = new MyLib.Dog();
a.Sound = "Woof";
Console.WriteLine(a.Sound);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal("Woof${Environment.NewLine}", output)
    }

    @Fact
    func CSharp_CanAccessVirtualProperty_OverrideChangesGetter() {
        let gsSource = `package MyLib
import System

open class Base {
    open prop Label string {
        get { return "base" }
    }
}

class Derived : Base {
    override prop Label string {
        get { return "derived" }
    }
}`
        let csSource = `using System;
MyLib.Base b = new MyLib.Derived();
Console.WriteLine(b.Label);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal("derived${Environment.NewLine}", output)
    }

    @Fact
    func CSharp_CanImplementInterface_WithGSharpProperty() {
        let gsSource = `package MyLib
import System

interface Named {
    prop Name string { get }
}

class User : Named {
    prop Name string
}`
        let csSource = `using System;
MyLib.Named n = new MyLib.User();
// User has both get and set, but Named only requires get
((MyLib.User)n).Name = "Bob";
Console.WriteLine(n.Name);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal("Bob${Environment.NewLine}", output)
    }

    @Fact
    func CSharp_PropertyVisibleToReflection_HasCorrectMetadata() {
        let gsSource = `package MyLib
import System

class Widget {
    prop Id int32
    prop Label string
    prop IsActive bool
}`
        let csSource = `using System;
using System.Reflection;
var t = typeof(MyLib.Widget);
var props = t.GetProperties(BindingFlags.Public | BindingFlags.Instance);
foreach (var p in props)
{
    Console.WriteLine($"{p.Name}:{p.PropertyType.Name}:{p.CanRead}:{p.CanWrite}");
}`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Contains("Id:Int32:True:True", output)
        Assert.Contains("Label:String:True:True", output)
        Assert.Contains("IsActive:Boolean:True:True", output)
    }

    @Fact
    func CSharp_PropertyAccessors_AreSpecialName() {
        let gsSource = `package MyLib
import System

class Item {
    prop Name string
}`
        let csSource = `using System;
using System.Reflection;
var t = typeof(MyLib.Item);
var getter = t.GetMethod("get_Name");
var setter = t.GetMethod("set_Name");
Console.WriteLine(getter.IsSpecialName);
Console.WriteLine(setter.IsSpecialName);
Console.WriteLine(getter.IsHideBySig);
Console.WriteLine(setter.IsHideBySig);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal(
            "True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    @Fact
    func CSharp_CanUseGSharpProperty_InObjectInitializer() {
        let gsSource = `package MyLib
import System

class Config {
    prop Host string
    prop Port int32
}`
        let csSource = `using System;
var cfg = new MyLib.Config { Host = "localhost", Port = 8080 };
Console.WriteLine(cfg.Host);
Console.WriteLine(cfg.Port);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal("localhost${Environment.NewLine}8080${Environment.NewLine}", output)
    }

    @Fact
    func CSharp_CanSerialize_GSharpPropertiesWithSystemTextJson() {
        let gsSource = `package MyLib
import System

class Product {
    prop Name string
    prop Price int32
}`
        let csSource = `using System;
using System.Text.Json;
var p = new MyLib.Product();
p.Name = "Widget";
p.Price = 999;
var json = JsonSerializer.Serialize(p);
Console.WriteLine(json);
var p2 = JsonSerializer.Deserialize<MyLib.Product>(json);
Console.WriteLine(p2.Name);
Console.WriteLine(p2.Price);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Contains("\"Name\":\"Widget\"", output)
        Assert.Contains("\"Price\":999", output)
        Assert.Equal("Widget", output.Split(Environment.NewLine)[1])
        Assert.Equal("999", output.Split(Environment.NewLine)[2])
    }

    @Fact
    func CSharp_DataStruct_ComputedProperty_IsAccessible() {
        let gsSource = `package MyLib
import System

data struct Vec2 {
    var X int32
    var Y int32
    prop LengthSquared int32 {
        get { return this.X * this.X + this.Y * this.Y }
    }
}`
        let csSource = `using System;
var v = new MyLib.Vec2();
v.X = 3;
v.Y = 4;
Console.WriteLine(v.LengthSquared);`
        let output = CompileGSharpAndRunCSharp(gsSource, csSource)
        Assert.Equal("25${Environment.NewLine}", output)
    }

    shared {
        /// Compiles GSharp source to a library DLL, then creates a C# project
        /// referencing it, builds, and runs the C# project. Returns stdout.
        private func CompileGSharpAndRunCSharp(gsSource string, csSource string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_prop_interop_").FullName
            try {
                // Step 1: Compile GSharp to a library DLL
                let gsDir = Path.Combine(tempDir, "gslib")
                Directory.CreateDirectory(gsDir)
                let gsSrcPath = Path.Combine(gsDir, "lib.gs")
                let gsDllPath = Path.Combine(gsDir, "MyLib.dll")
                File.WriteAllText(gsSrcPath, gsSource)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + gsDllPath, "/target:library", "/targetframework:net10.0", gsSrcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(gsDllPath)
                Assert.True(File.Exists(gsDllPath), "GSharp DLL not found at $gsDllPath")
                // Step 2: Create a C# console project referencing the GSharp DLL
                let csDir = Path.Combine(tempDir, "csapp")
                Directory.CreateDirectory(csDir)
                let csProjContent = (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="MyLib">
      <HintPath>` + "$gsDllPath" + `</HintPath>
    </Reference>
  </ItemGroup>
</Project>`)
                File.WriteAllText(Path.Combine(csDir, "CsApp.csproj"), csProjContent)
                File.WriteAllText(Path.Combine(csDir, "Program.cs"), csSource)
                // Step 3: Build the C# project
                let buildPsi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = csDir
                }
                buildPsi.ArgumentList.Add("build")
                buildPsi.ArgumentList.Add("--nologo")
                buildPsi.ArgumentList.Add("-c")
                buildPsi.ArgumentList.Add("Release")
                buildPsi.ArgumentList.Add("--no-restore")
                // First restore (needed for new project)
                let restorePsi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = csDir
                }
                restorePsi.ArgumentList.Add("restore")
                using let restoreProc = Process.Start(restorePsi)!!
                restoreProc.StandardOutput.ReadToEnd()
                let restoreErr = restoreProc.StandardError.ReadToEnd()
                restoreProc.WaitForExit(60_000)
                Assert.True(restoreProc.ExitCode == 0, (`dotnet restore failed:
` + "$restoreErr"))
                using let buildProc = Process.Start(buildPsi)!!
                let buildStdout = buildProc.StandardOutput.ReadToEnd()
                let buildStderr = buildProc.StandardError.ReadToEnd()
                buildProc.WaitForExit(60_000)
                Assert.True(buildProc.ExitCode == 0, (`dotnet build failed:
stdout:
` + "$buildStdout" + `
stderr:
` + "$buildStderr"))
                // Step 4: Run the C# project
                let runPsi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = csDir
                }
                runPsi.ArgumentList.Add("run")
                runPsi.ArgumentList.Add("-c")
                runPsi.ArgumentList.Add("Release")
                runPsi.ArgumentList.Add("--no-build")
                using let runProc = Process.Start(runPsi)!!
                let stdout = runProc.StandardOutput.ReadToEnd()
                let stderr = runProc.StandardError.ReadToEnd()
                runProc.WaitForExit(30_000)
                Assert.True(runProc.ExitCode == 0, (`dotnet run failed (exit ` + "${runProc.ExitCode}" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
