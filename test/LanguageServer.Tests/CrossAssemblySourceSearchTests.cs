// <copyright file="CrossAssemblySourceSearchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Regression tests for Tier-3 cross-assembly navigation (source-text search). Portable PDBs
/// only record sequence points for method bodies, so go-to-definition on a C# interface (or any
/// type with no executable code) can't be located via the PDB; instead the owning project's
/// source files are scanned for the declaration.
/// </summary>
public class CrossAssemblySourceSearchTests
{
    [Fact]
    public void SourceSearch_FindsInterfaceDeclaration_FromSiblingProjectLayout()
    {
        // Mimic the standard MSBuild layout: <project>/obj/.../<asm>.dll with sources under
        // <project>. Tier 2 (PDB) can't resolve interfaces, so Tier 3 must find the source.
        var projectDir = Path.Combine(Path.GetTempPath(), "gsxasm_" + Guid.NewGuid().ToString("N"), "MyLib");
        var objDll = Path.Combine(projectDir, "obj", "Debug", "net10.0", "ref", "MyLib.dll");
        Directory.CreateDirectory(Path.GetDirectoryName(objDll));
        Directory.CreateDirectory(Path.Combine(projectDir, "Auth"));
        try
        {
            File.WriteAllText(objDll, "not-a-real-dll"); // only the path matters for Tier 3
            var srcFile = Path.Combine(projectDir, "Auth", "Broker.cs");
            File.WriteAllText(srcFile, "namespace X\n{\n    public interface IAuthCallbackBroker\n    {\n        void Solve();\n    }\n}\n");

            // type is only consulted for its simple name (matches the declared interface).
            var ok = CrossAssemblyDefinitionResolver.TryResolveTypeBySourceSearch(objDll, typeof(IAuthCallbackBroker), out var location);

            Assert.True(ok);
            Assert.NotNull(location);
            Assert.Equal(srcFile, location.Uri.GetFileSystemPath());
            Assert.Equal(2, location.Range.Start.Line); // `public interface IAuthCallbackBroker` is line 2 (0-based)
        }
        finally
        {
            try { Directory.Delete(Path.GetDirectoryName(projectDir), recursive: true); } catch { }
        }
    }

    [Fact]
    public void SourceSearch_ReturnsFalse_WhenAssemblyNotUnderProjectLayout()
    {
        // A NuGet/SDK assembly path with no obj/bin project root must not match anything.
        var ok = CrossAssemblyDefinitionResolver.TryResolveTypeBySourceSearch(
            "/usr/share/dotnet/shared/Microsoft.NETCore.App/10.0.0/System.Runtime.dll",
            typeof(IDummyAuthCallbackBroker),
            out var location);

        Assert.False(ok);
        Assert.Null(location);
    }

    [Fact]
    public void MemberSourceSearch_FindsMethodDeclaration_NotCallSites()
    {
        var projectDir = Path.Combine(Path.GetTempPath(), "gsxmem_" + Guid.NewGuid().ToString("N"), "MyLib");
        var objDll = Path.Combine(projectDir, "obj", "Debug", "net10.0", "ref", "MyLib.dll");
        Directory.CreateDirectory(Path.GetDirectoryName(objDll));
        try
        {
            File.WriteAllText(objDll, "not-a-real-dll");
            var srcFile = Path.Combine(projectDir, "Service.cs");
            // Call site of ToCliRegion appears first; the declaration is later. The search must
            // skip the call and land on the declaration.
            File.WriteAllText(
                srcFile,
                "namespace X\n{\n    public sealed class CoreAuthService\n    {\n        public int Use() => ToCliRegion(0) + 1;\n\n        public static int ToCliRegion(int region) => region;\n    }\n}\n");

            var ok = CrossAssemblyDefinitionResolver.TryResolveMemberBySourceSearch(objDll, typeof(CoreAuthService), "ToCliRegion", out var location);

            Assert.True(ok);
            Assert.NotNull(location);
            Assert.Equal(srcFile, location.Uri.GetFileSystemPath());
            // The declaration `public static int ToCliRegion(...)` is on line 6 (0-based).
            Assert.Equal(6, location.Range.Start.Line);
        }
        finally
        {
            try { Directory.Delete(Path.GetDirectoryName(projectDir), recursive: true); } catch { }
        }
    }

    // A type whose simple name matches the interface declared in the synthetic source above.
    private interface IAuthCallbackBroker
    {
    }

    private interface IDummyAuthCallbackBroker
    {
    }

    // A type whose simple name matches the class declared in the member-search source above.
    private sealed class CoreAuthService
    {
    }
}
